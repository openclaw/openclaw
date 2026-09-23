import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { shellEscape } from "../agents/sandbox/remote-shell-command.js";
import { GatewayChatClient } from "../tui/gateway-chat.js";
import type { TuiEvent } from "../tui/tui-backend.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtures = [
  { path: "payload.txt", content: "complete-seed-bytes\n" },
  { path: "nested/second.txt", content: "second-fixture-bytes\n" },
];

function writeReadCalls(response: ServerResponse, paths: string[], requestIndex: number) {
  const items = paths.map((filePath, index) => ({
    type: "function_call",
    id: `fc_read_${requestIndex}_${index}`,
    call_id: `call_read_${requestIndex}_${index}`,
    name: "read",
    arguments: JSON.stringify({ path: filePath }),
    status: "completed",
  }));
  writeOpenAiResponsesSse(response, [
    ...items.flatMap((item, index) => [
      {
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, status: "in_progress", arguments: "" },
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: `resp_read_${requestIndex}`,
        status: "completed",
        output: items,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

describe.runIf(process.platform !== "win32")("Gateway SSH workspace seeding", () => {
  it(
    "reports an upload child termination through chat.send and read, then seeds complete files on retry",
    { timeout: 180_000 },
    async () => {
      const root = tempDirs.make("gateway-ssh-upload-");
      const workspace = path.join(root, "local");
      const endpoint = path.join(root, "remote");
      const armed = path.join(root, "fail-upload");
      const archive = path.join(root, "consumed.tar");
      const transport = path.join(root, "transport.sh");
      const endpointBin = path.join(root, "bin");
      await fs.mkdir(path.join(workspace, "nested"), { recursive: true });
      await fs.mkdir(endpoint);
      await fs.mkdir(endpointBin);
      if (process.platform === "darwin") {
        // The remote filesystem contract requires GNU stat, named gstat on macOS.
        await fs.writeFile(path.join(endpointBin, "stat"), '#!/bin/sh\nexec gstat "$@"\n', {
          mode: 0o700,
        });
      }
      for (const fixture of fixtures) {
        await fs.writeFile(path.join(workspace, fixture.path), fixture.content);
      }
      await fs.writeFile(armed, "armed");
      await fs.writeFile(
        transport,
        [
          "#!/bin/sh",
          "set -eu",
          `export PATH=${shellEscape(endpointBin)}:"$PATH"`,
          "for command do :; done",
          'case "$command" in',
          "  *openclaw-sandbox-upload*)",
          `    if [ -f ${shellEscape(armed)} ]; then`,
          // Consume the real archive first so the regression reaches close with a signal,
          // rather than failing earlier from a broken pipe.
          `      cat > ${shellEscape(archive)}`,
          "      ulimit -c 0",
          `      exec ${shellEscape(process.execPath)} -e 'process.abort()'`,
          "    fi",
          "    ;;",
          "esac",
          'exec /bin/sh -c "$command"',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );

      let requestedPaths = ["payload.txt"];
      let requestIndex = 0;
      const server = createServer((request, response) => {
        request.resume();
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        requestIndex += 1;
        if (requestedPaths.length === 0) {
          writeOpenAiResponsesText(response, {
            text: "Read results received.",
            messageId: `msg_${requestIndex}`,
            responseId: `resp_${requestIndex}`,
          });
        } else {
          writeReadCalls(
            response,
            [expectDefined(requestedPaths.shift(), "queued read")],
            requestIndex,
          );
        }
      });
      let instance: OpenClawTestInstance | undefined;
      let client: GatewayChatClient | undefined;
      await runQaGatewayFixture(
        async () => {
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Model fixture did not bind a TCP port");
          }
          const provider = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${address.port}/v1`,
            "upload-fixture",
          );
          instance = await createOpenClawTestInstance({
            name: "gateway-ssh-upload",
            config: {
              plugins: { slots: { memory: "none" } },
              agents: {
                defaults: {
                  workspace,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: {
                      agentRuntime: { id: "openclaw" },
                      params: { transport: "sse", openaiWsWarmup: false },
                    },
                  },
                  skills: [],
                  skipBootstrap: true,
                  sandbox: {
                    mode: "all",
                    backend: "ssh",
                    scope: "session",
                    workspaceAccess: "rw",
                    ssh: { target: "fixture", command: transport, workspaceRoot: endpoint },
                  },
                },
                entries: { main: { default: true, skills: [] } },
              },
              tools: { profile: "minimal", alsoAllow: ["read"] },
              models: {
                mode: "replace",
                providers: {
                  [provider.providerId]: {
                    ...provider.config,
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
            },
            env: {
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            },
          });
          await instance.startGateway();
          const events: TuiEvent[] = [];
          const chat = new GatewayChatClient({ url: instance.url, token: instance.gatewayToken });
          client = chat;
          chat.onEvent = (event) => events.push(event);
          chat.start();
          await chat.waitForReady();
          await chat.subscribeSessionEvents();
          const sessionKey = `agent:main:upload-${randomUUID()}`;
          const readFiles = async (paths: string[]) => {
            requestedPaths = [...paths];
            const { runId } = await chat.sendChat({
              sessionKey,
              message: `Use read to read ${paths.join(" and ")}.`,
            });
            await vi.waitUntil(
              () =>
                events.some(
                  ({ event, payload }) =>
                    event === "chat" &&
                    isRecord(payload) &&
                    payload.runId === runId &&
                    ["final", "error", "aborted"].includes(String(payload.state)),
                ),
              { timeout: 30_000 },
            );
            return events.flatMap(({ event, payload }) =>
              event === "agent" &&
              isRecord(payload) &&
              payload.runId === runId &&
              payload.stream === "tool" &&
              isRecord(payload.data) &&
              payload.data.phase === "result"
                ? [payload.data]
                : [],
            );
          };

          const failed = await readFiles(["payload.txt"]);
          expect((await fs.stat(archive)).size).toBeGreaterThan(0);
          expect(await fs.readdir(endpoint)).toEqual([]);
          expect(failed).toMatchObject([
            {
              name: "read",
              isError: true,
              result: { details: { error: "remote exited from signal SIGABRT" } },
            },
          ]);

          await fs.unlink(armed);
          const completed = await readFiles(fixtures.map((fixture) => fixture.path));
          expect(completed).toHaveLength(fixtures.length);
          for (const fixture of fixtures) {
            expect(completed).toContainEqual(
              expect.objectContaining({
                name: "read",
                isError: false,
                result: expect.objectContaining({
                  content: [{ type: "text", text: fixture.content }],
                }),
              }),
            );
          }
          const published = await fs.readdir(endpoint);
          expect(published).toHaveLength(1);
          const runtime = expectDefined(published[0], "published runtime");
          expect(runtime).not.toContain(".bootstrap-");
          for (const fixture of fixtures) {
            expect(
              await fs.readFile(path.join(endpoint, runtime, "workspace", fixture.path)),
            ).toEqual(Buffer.from(fixture.content));
          }
        },
        () => client?.stop(),
        () => instance?.cleanup(),
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      );
    },
  );
});
