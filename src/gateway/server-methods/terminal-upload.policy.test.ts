import * as fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stageTerminalUpload } from "../../infra/terminal-file-upload.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import {
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "../terminal/session-manager.test-helpers.js";
import { terminalUploadHandlers } from "./terminal-upload.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), writeFile: vi.fn(actual.writeFile) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(["queued", "before-write"])(
  "refuses terminal client bytes after hot disable %s without writing then cleaning up",
  async (phase) => {
    const root = dirs.make("openclaw-terminal-policy-");
    let config: OpenClawConfig = { gateway: { uploads: { enabled: true } } };
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => makeFakePty() });
    const opened = expectTerminalOpen(
      await manager.open(
        baseOpenRequest({
          stageUpload: (file) => stageTerminalUpload(file, { tempRoot: root }),
        }),
      ),
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.mocked(fs.lstat).mockImplementation(
      new Proxy(actualFs.lstat, {
        async apply(target, receiver, args: Parameters<typeof actualFs.lstat>) {
          const result = await Reflect.apply(target, receiver, args);
          if (
            typeof args[0] === "string" &&
            path.dirname(args[0]) === root &&
            path.basename(args[0]).startsWith("openclaw-terminal-upload-")
          ) {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      }),
    );
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      getCommittedRuntimeConfig: () => config,
      terminalSessions: manager,
      isTerminalEnabled: () => true,
    });
    const respond = vi.fn();
    const params = { sessionId: opened.sessionId, name: "client.bin", contentBase64: "AQID" };
    const invoke = () =>
      expectDefined(
        terminalUploadHandlers["terminal.upload"],
        "terminal.upload",
      )({
        req: { type: "req", id: "upload", method: "terminal.upload", params },
        params,
        context,
        respond,
        isWebchatConnect: () => false,
        client: {
          connId: "conn-1",
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "test", version: "1", platform: "test", mode: "test" },
          },
        },
      });
    const agent =
      phase === "queued"
        ? stageTerminalUpload({ name: "agent.bin", contentBase64: "BAUG" }, { tempRoot: root })
        : undefined;
    if (agent) {
      await entered.promise;
    }
    const pending = Promise.resolve(invoke());
    try {
      if (!agent) {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("upload never reached filesystem preparation");
          }),
        ]);
      }
      config = { gateway: { uploads: { enabled: false } } };
      release.resolve();
      await pending;
      expect
        .soft(respond)
        .toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
        );
      expect
        .soft(
          vi
            .mocked(fs.writeFile)
            .mock.calls.filter(
              ([target]) => typeof target === "string" && path.basename(target) === "client.bin",
            ),
        )
        .toHaveLength(0);
      const files = await fs.readdir(root, { recursive: true });
      expect.soft(files.filter((file) => file.endsWith("client.bin"))).toEqual([]);
      if (agent) {
        expect(await fs.readFile((await agent).path)).toEqual(Buffer.from([4, 5, 6]));
      }
    } finally {
      release.resolve();
      await pending;
      await agent;
      manager.close("conn-1", opened.sessionId);
    }
  },
);
