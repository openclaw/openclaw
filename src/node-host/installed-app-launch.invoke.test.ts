import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.node-host.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { NodeHostClient } from "./client.js";
import { handleInvoke } from "./invoke.js";

type InvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
};

// This is the native boundary only. The input permit is NOT an ordinary exec
// approval. The separate paired Gateway fixture must exercise real approvals.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  resetPluginRuntimeStateForTest();
});

describe.runIf(process.platform === "linux")("optional installed-app native boundary", () => {
  it.each([
    "allowed",
    "ask-required",
    "exec-denied",
    "entry-changed",
    "exec-revoked",
    "cancel-after-permit",
    "cwd-replaced",
    "os-error",
  ] as const)("keeps node policy and real process semantics: %s", async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const data = state.path("app-data");
      fs.mkdirSync(path.join(data, "applications"), { recursive: true });
      const executable = state.path("task-owned-native");
      fs.copyFileSync("/usr/bin/yes", executable);
      fs.chmodSync(executable, 0o755);
      if (mode === "os-error") {
        const bytes = fs.readFileSync(executable);
        const loader = bytes.indexOf(Buffer.from("ld-linux"));
        expect(loader).toBeGreaterThan(0);
        bytes.write("xx-linux", loader, "ascii");
        fs.writeFileSync(executable, bytes);
      }
      const cwd = state.path("approved-cwd");
      fs.mkdirSync(cwd);
      const entry = path.join(data, "applications", "fixture.desktop");
      fs.writeFileSync(
        entry,
        "[Desktop Entry]\nType=Application\nName=Fixture\nExec=" + executable + "\n",
      );
      vi.stubEnv("XDG_DATA_HOME", data);
      vi.stubEnv("XDG_DATA_DIRS", data);
      saveExecApprovals({
        version: 1,
        agents: {
          main: {
            security: mode === "exec-denied" ? "deny" : "allowlist",
            ask: mode === "ask-required" ? "always" : "off",
            allowlist: [{ pattern: executable }],
          },
        },
      });

      let response: InvokeResult | undefined;
      const request: NodeHostClient["request"] = async (method, value) => {
        if (method === "node.invoke.result") {
          response = value as InvokeResult;
        }
        return {} as never;
      };
      const invoke = async (
        command: string,
        params: unknown,
        io?: OpenClawPluginNodeHostCommandIo,
      ): Promise<InvokeResult | undefined> => {
        response = undefined;
        await handleInvoke(
          {
            id: "app-native-" + command,
            nodeId: "node",
            command,
            paramsJSON: JSON.stringify(params),
          },
          { request },
          { current: async () => [] },
          undefined,
          {
            installedAppsSharingEnabled: true,
            installedAppsPlatform: "linux",
            pluginCommandIo: io,
          },
        );
        return response;
      };

      // Use the registered inventory, not a hardcoded revision or a missing
      // parser import: the initial baseline should fail on unsupported inventory.
      const inventory = await invoke("device.apps", { query: "Fixture", includeSystem: true });
      expect(inventory).toMatchObject({ ok: true });
      const payload = JSON.parse(inventory?.payloadJSON ?? "null") as {
        inventoryComplete: boolean;
        truncated: boolean;
        apps: Array<{ appId: string; appRevision: string }>;
      };
      expect(payload).toMatchObject({ inventoryComplete: true, truncated: false });
      expect(payload.apps).toHaveLength(1);
      const app = expectDefined(payload.apps[0], "registered app inventory");
      expect(app.appId).toBe("linux-desktop:fixture.desktop");
      expect(app.appRevision).toMatch(/^[0-9a-f]{64}$/);

      const children: ChildProcess[] = [];
      const cleanupChildren = async () => {
        for (const child of children) {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
        }
      };
      // Also runs if a broken run-to-completion adapter outlives the test deadline.
      onTestFinished(cleanupChildren);
      const spawn = childProcess.spawn;
      vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        if (args[0] === executable) {
          children.push(child);
        }
        return child;
      });
      syncBuiltinESMExports();
      const controller = new AbortController();
      let input: ((raw: string) => void) | undefined;
      const ready = vi.fn(async (chunk: string) => {
        expect(JSON.parse(chunk)).toMatchObject({
          type: "installed-app-launch.ready",
          appId: app.appId,
          appRevision: app.appRevision,
        });
        if (mode === "entry-changed") {
          fs.appendFileSync(entry, "Hidden=true\n");
        }
        if (mode === "exec-revoked") {
          saveExecApprovals({ version: 1, agents: { main: { security: "deny", ask: "off" } } });
        }
        if (mode === "cwd-replaced") {
          fs.renameSync(cwd, cwd + ".old");
          fs.mkdirSync(cwd);
        }
        expectDefined(
          input,
          "invocation input owner",
        )(JSON.stringify({ type: "installed-app-launch.allow", validForMs: 5000 }));
        if (mode === "cancel-after-permit") {
          controller.abort(new Error("fixture cancel before spawn"));
        }
      });
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        const result = await invoke(
          "device.apps.launch",
          { appId: app.appId, appRevision: app.appRevision, agentId: "main" },
          {
            signal: controller.signal,
            onInput: (listener) => {
              input = listener;
            },
            emitChunk: ready,
          },
        );
        if (mode === "allowed") {
          expect(children).toHaveLength(1);
          const child = expectDefined(children[0], "actual spawned child");
          expect(child.pid).toBeGreaterThan(0);
          expect(result).toMatchObject({
            ok: true,
            payload: {
              status: "process-started",
              appId: app.appId,
              appRevision: app.appRevision,
              pid: child.pid,
            },
          });
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
          expect(() => process.kill(expectDefined(child.pid, "spawned PID"), 0)).not.toThrow();
        } else {
          expect(children).toHaveLength(mode === "os-error" ? 1 : 0);
          expect(children.every((child) => child.pid === undefined)).toBe(true);
          expect(result).toMatchObject({ ok: false });
          expect(result?.error?.message).toContain(
            mode === "os-error"
              ? "ENOENT"
              : mode === "cancel-after-permit"
                ? "fixture cancel before spawn"
                : mode === "entry-changed"
                  ? "INSTALLED_APP_CHANGED"
                  : mode === "exec-denied"
                    ? "SYSTEM_RUN_DISABLED: security=deny"
                    : "SYSTEM_RUN_DENIED",
          );
        }
        if (mode === "ask-required" || mode === "exec-denied") {
          expect(ready).not.toHaveBeenCalled();
        } else {
          expect(ready).toHaveBeenCalledOnce();
        }
      } finally {
        // Even an assertion failure must join every task-owned native effect.
        await cleanupChildren();
        cwdSpy.mockRestore();
      }
    });
  });
});
