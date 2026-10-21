// Proves exact file grants across the registered plugin policy and real node transport.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import fileTransferPlugin from "../../../../extensions/file-transfer/index.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { withNodeGateway } from "./node-gateway-fixture.js";

const E2E_TIMEOUT_MS = 180_000;
const FILE_FETCH_COMMAND = "file.fetch";

type NodeInvokeFrame = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON: string | null;
};

type CapturedInvocation = {
  command: string;
  params: Record<string, unknown>;
};

it("rejects a replaced file before final I/O", { timeout: E2E_TIMEOUT_MS }, async () => {
  const command = fileTransferPlugin.nodeHostCommands?.find(
    (entry) => entry.command === FILE_FETCH_COMMAND,
  );
  if (!command) {
    throw new Error("file-transfer plugin omitted file.fetch");
  }
  const invocations: CapturedInvocation[] = [];
  const handlerErrors: Error[] = [];
  const invocationResponses: Promise<void>[] = [];
  let target = "",
    approvedObject = "",
    canonicalPath = "";
  let replaced = false;
  await withNodeGateway(
    {
      label: "qa-file-transfer-exact-approval",
      plugin: fileTransferPlugin,
      platform: process.platform,
      caps: ["file"],
      commands: [FILE_FETCH_COMMAND],
      config: async ({ state, nodeId }) => {
        target = path.join(state.home, "report.txt");
        approvedObject = path.join(state.home, "approved-object.txt");
        await fs.writeFile(target, "approved");
        canonicalPath = await fs.realpath(target);
        return {
          gateway: { nodes: { commands: { allow: [FILE_FETCH_COMMAND] } } },
          agents: {
            defaults: { skipBootstrap: true },
          },
          plugins: {
            allow: ["file-transfer"],
            entries: {
              "file-transfer": {
                enabled: true,
                config: {
                  policyVersion: 2,
                  nodes: { [nodeId]: { ask: "on-miss" } },
                  literalGrants: [
                    {
                      nodeId,
                      command: FILE_FETCH_COMMAND,
                      requestedPath: target,
                      canonicalPath,
                    },
                  ],
                },
              },
            },
          },
        };
      },
      onInvoke: (client, frame) => {
        invocationResponses.push(
          respondToFileFetch({
            client,
            frame,
            command,
            invocations,
            beforePreflightResponse: async () => {
              if (replaced) {
                return;
              }
              replaced = true;
              await fs.rename(target, approvedObject);
              await fs.writeFile(target, "replacement");
            },
          }).catch((error: unknown) => {
            handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
          }),
        );
      },
      beforeCleanup: async () => {
        await Promise.all(invocationResponses);
      },
    },
    async ({ registry, operator, nodeId }) => {
      expect(
        registry.registry.nodeInvokePolicies.map(({ pluginId, policy }) => ({
          pluginId,
          commands: policy.commands,
        })),
      ).toEqual([
        { pluginId: "file-transfer", commands: ["workspace.memory"] },
        { pluginId: "file-transfer", commands: ["workspace.skills"] },
        {
          pluginId: "file-transfer",
          commands: [
            FILE_FETCH_COMMAND,
            "file.stat",
            "dir.list",
            "dir.fetch",
            "file.write",
            "file.create",
          ],
        },
      ]);

      const result = await operator.request<{
        payload?: { ok?: boolean; code?: string };
      }>("node.invoke", {
        nodeId,
        command: FILE_FETCH_COMMAND,
        params: { path: target },
        timeoutMs: 60_000,
        idempotencyKey: randomUUID(),
      });

      expect(invocations).toEqual(
        [
          { preflightOnly: true, followSymlinks: false },
          { expectedBinding: expect.objectContaining({ kind: "existing" }) },
        ].map((params) => ({
          command: FILE_FETCH_COMMAND,
          params: expect.objectContaining({
            path: target,
            expectedCanonicalPath: canonicalPath,
            ...params,
          }),
        })),
      );
      expect(result.payload).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
      await expect(fs.readFile(approvedObject, "utf8")).resolves.toBe("approved");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
      await Promise.all(invocationResponses);
      expect(handlerErrors).toEqual([]);
    },
  );
});

async function respondToFileFetch(params: {
  client: GatewayClient | undefined;
  frame: unknown;
  command: NonNullable<(typeof fileTransferPlugin)["nodeHostCommands"]>[number];
  invocations: CapturedInvocation[];
  beforePreflightResponse: () => Promise<void>;
}): Promise<void> {
  const frame = params.frame as Partial<NodeInvokeFrame>;
  if (
    !params.client ||
    typeof frame.id !== "string" ||
    typeof frame.nodeId !== "string" ||
    frame.command !== FILE_FETCH_COMMAND ||
    !(frame.paramsJSON === null || typeof frame.paramsJSON === "string")
  ) {
    throw new Error(`invalid file.fetch node invocation: ${JSON.stringify(frame)}`);
  }
  const commandParams = JSON.parse(frame.paramsJSON ?? "{}") as Record<string, unknown>;
  params.invocations.push({ command: frame.command, params: commandParams });
  const payloadJSON = await params.command.handle(frame.paramsJSON);
  if (commandParams.preflightOnly === true) {
    await params.beforePreflightResponse();
  }
  await params.client.request("node.invoke.result", {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: true,
    payloadJSON,
  });
}
