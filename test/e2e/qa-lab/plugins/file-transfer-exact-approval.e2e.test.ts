// Proves exact file grants across the registered plugin policy and real node transport.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import fileTransferPlugin from "../../../../extensions/file-transfer/index.js";
import { withNodeGateway } from "./node-gateway-fixture.js";

const E2E_TIMEOUT_MS = 180_000;
const FILE_FETCH_COMMAND = "file.fetch";

it("rejects a replaced file before final I/O", { timeout: E2E_TIMEOUT_MS }, async () => {
  const command = fileTransferPlugin.nodeHostCommands?.find(
    (entry) => entry.command === FILE_FETCH_COMMAND,
  );
  if (!command) {
    throw new Error("file-transfer plugin omitted file.fetch");
  }
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
      onInvoke: async (frame) => {
        expect(frame.command).toBe(FILE_FETCH_COMMAND);
        const params = JSON.parse(frame.paramsJSON ?? "{}") as Record<string, unknown>;
        const result = await command.handle(frame.paramsJSON);
        if (params.preflightOnly === true && !replaced) {
          replaced = true;
          await fs.rename(target, approvedObject);
          await fs.writeFile(target, "replacement");
        }
        return result;
      },
    },
    async ({ operator, nodeId, invocations }) => {
      const result = await operator.request<{
        payload?: { ok?: boolean; code?: string };
      }>("node.invoke", {
        nodeId,
        command: FILE_FETCH_COMMAND,
        params: { path: target },
        timeoutMs: 60_000,
        idempotencyKey: randomUUID(),
      });

      expect(
        invocations.map(({ command: invokedCommand, params }) => ({
          command: invokedCommand,
          params,
        })),
      ).toEqual(
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
    },
  );
});
