import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { splitSandboxBindSpec } from "../agents/sandbox/bind-spec.js";
import { readRegistry, readRegistryEntry } from "../agents/sandbox/registry.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import {
  createGatewayConfigPath,
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const native = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../infra/executable-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/executable-path.js")>();
  return {
    ...actual,
    resolveExecutableFromPathEnv: (
      ...args: Parameters<typeof actual.resolveExecutableFromPathEnv>
    ) => (args[0] === "docker" ? process.execPath : actual.resolveExecutableFromPathEnv(...args)),
  };
});
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  return {
    ...actual,
    spawnCommand: (...args: Parameters<typeof actual.spawnCommand>) => {
      const argv = args[0];
      if (argv[0] === process.execPath && argv[1] === "--host") {
        return native.execute(argv.slice(3));
      }
      if (argv[0] === "docker") {
        return native.execute(argv.slice(1));
      }
      return actual.spawnCommand(...args);
    },
  };
});

type InspectedMount = { Type: string; Source: string; Destination: string; RW: boolean };

function installNativeTransport(root: string, failWait: boolean) {
  const selfId = "f".repeat(64);
  const reachedWait = createDeferred();
  const releaseWait = createDeferred();
  const commands: string[] = [];
  let creates = 0;
  let allocation:
    | {
        Id: string;
        Name: string;
        Config: { Labels: Record<string, string> };
        HostConfig: {
          PidMode: string;
          AutoRemove: boolean;
          RestartPolicy: { Name: string };
          Tmpfs: Record<string, string>;
        };
        State: Record<string, unknown>;
        Mounts: InspectedMount[];
      }
    | undefined;

  native.execute.mockImplementation(async (args: string[]) => {
    const command = expectDefined(args[0], "native command");
    commands.push(command);
    let output: unknown = "";
    if (command === "info") {
      output = { OSType: "linux", ID: "foreground-fixture-daemon" };
    } else if (command === "create") {
      const labels: Record<string, string> = {};
      const mounts: InspectedMount[] = [];
      const tmpfs: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (flag === "--label") {
          const label = expectDefined(args[++index], "allocation label");
          const separator = label.indexOf("=");
          labels[label.slice(0, separator)] = label.slice(separator + 1);
        } else if (flag === "-v") {
          const bind = expectDefined(
            splitSandboxBindSpec(expectDefined(args[++index], "allocation bind")),
            "parsed allocation bind",
          );
          mounts.push({
            Type: "bind",
            Source: bind.host,
            Destination: bind.container,
            RW: !bind.options.split(",").includes("ro"),
          });
        } else if (flag === "--tmpfs") {
          const spec = expectDefined(args[++index], "allocation tmpfs");
          const [destination, options = ""] = spec.split(":");
          tmpfs[expectDefined(destination, "tmpfs destination")] = options;
        }
      }
      creates += 1;
      allocation = {
        Id: creates.toString(16).padStart(64, "0"),
        Name: "/" + expectDefined(args[args.indexOf("--name") + 1], "allocation name"),
        Config: { Labels: labels },
        HostConfig: {
          PidMode: "",
          AutoRemove: false,
          RestartPolicy: { Name: "no" },
          Tmpfs: tmpfs,
        },
        State: {
          Status: "created",
          Running: false,
          Paused: false,
          Restarting: false,
          Dead: false,
          Pid: 0,
          Error: "",
          ExitCode: 0,
          StartedAt: "0001-01-01T00:00:00Z",
          FinishedAt: "0001-01-01T00:00:00Z",
        },
        Mounts: mounts,
      };
      output = allocation.Id;
    } else if (command === "inspect") {
      if (args.includes("--type")) {
        // Real Linux self-discovery proves kernel/mount identity below. Only the
        // fixture root is exposed; allocation inspection has separate receipts.
        output = {
          Id: selfId,
          Mounts: [{ Type: "bind", Source: root, Destination: root, RW: true }],
          Tmpfs: null,
        };
      } else {
        const owned = expectDefined(allocation, "inspected allocation");
        expect(args.at(-1)).toBe(owned.Id);
        output = args.includes('{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}')
          ? { Mounts: owned.Mounts, Tmpfs: owned.HostConfig.Tmpfs }
          : owned;
      }
    } else if (command === "exec") {
      if (args[1] === selfId) {
        output = JSON.stringify([
          (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
          await fs.readlink("/proc/self/ns/mnt"),
        ]);
      } else if (args.includes("/proc/self/mountinfo")) {
        const owned = expectDefined(allocation, "mounted allocation");
        const mounts = [
          ...owned.Mounts.map((mount) => ({
            path: mount.Destination,
            rw: mount.RW,
            type: "none",
          })),
          ...Object.entries(owned.HostConfig.Tmpfs).map(([destination, options]) => ({
            path: destination,
            rw: !options.split(",").includes("ro"),
            type: "tmpfs",
          })),
        ];
        output =
          "1 1 0:1 / / rw - overlay overlay rw\n" +
          mounts
            .map(
              (mount, index) =>
                String(index + 2) +
                " 1 0:" +
                String(index + 2) +
                " / " +
                mount.path +
                " " +
                (mount.rw ? "rw" : "ro") +
                " - " +
                mount.type +
                " fixture rw\n",
            )
            .join("");
      } else {
        throw new Error("Unexpected sandbox command before provider admission");
      }
    } else if (command === "start") {
      const owned = expectDefined(allocation, "started allocation");
      expect(args[1]).toBe(owned.Id);
      Object.assign(owned.State, {
        Status: "running",
        Running: true,
        Pid: 123,
        StartedAt: "2026-01-01T00:00:00Z",
      });
    } else if (command === "kill") {
      const owned = expectDefined(allocation, "stopped allocation");
      expect(args.at(-1)).toBe(owned.Id);
      Object.assign(owned.State, {
        Status: "exited",
        Running: false,
        Pid: 0,
        ExitCode: 137,
        FinishedAt: "2026-01-01T00:00:01Z",
      });
    } else if (command === "wait") {
      expect(args[1]).toBe(expectDefined(allocation, "waited allocation").Id);
      reachedWait.resolve();
      await releaseWait.promise;
      if (failWait) {
        // This ordinary native failure must be branded by real retirement.
        return {
          failed: true,
          exitCode: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("native wait receipt unavailable"),
        };
      }
      output = "137";
    } else if (command === "rm") {
      expect(args).toEqual(["rm", expectDefined(allocation, "retired allocation").Id]);
      allocation = undefined;
    } else if (command !== "image") {
      throw new Error("Unexpected native command: " + command);
    }
    return {
      failed: false,
      exitCode: 0,
      stdout: Buffer.from(typeof output === "string" ? output : JSON.stringify(output)),
      stderr: Buffer.alloc(0),
    };
  });
  return { commands, reachedWait, releaseWait };
}

beforeEach(resetGatewayTestState);
afterEach(() => {
  native.execute.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetGatewayTestState();
});

it.each([false, true])(
  "joins real foreground Stop and native retirement (uncertain=%s)",
  { timeout: 90_000 },
  async (failWait, context) => {
    const { signal } = context;
    const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
      prefix: "openclaw-foreground-stop-",
    });
    const transport = installNativeTransport(await fs.realpath(tempHome), failWait);
    vi.stubEnv("DOCKER_CONTEXT", "");
    vi.stubEnv("DOCKER_HOST", "unix:///" + nextGatewayId("foreground-engine") + ".sock");
    const originalFetch = globalThis.fetch;
    const entered = [createDeferred(), createDeferred()] as const;
    let providerRequests = 0;
    const provider = buildMockOpenAiResponsesProvider("https://foreground-provider.invalid/v1");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== provider.config.baseUrl + "/responses") {
        return originalFetch(input, init);
      }
      const abort = expectDefined(
        init?.signal ?? (input instanceof Request ? input.signal : undefined),
        "provider transport abort signal",
      );
      const gate = expectDefined(entered[providerRequests++], "expected provider request");
      gate.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        if (abort.aborted) {
          reject(abort.reason);
        } else {
          abort.addEventListener("abort", () => reject(abort.reason), { once: true });
        }
      });
    });
    const token = nextGatewayId("foreground-token");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", token);
    const sessionKey = "agent:main:foreground";
    const sessionId = nextGatewayId("foreground-session");
    const scope = { agentId: "main", sessionKey };
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const events: Array<{ runId: string; state: string; seq: number; errorMessage?: string }> = [];
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let admissionRelease: Promise<void> | undefined;
    await runQaGatewayTestFixture(
      context,
      async () => {
        const configPath = await createGatewayConfigPath(tempHome);
        gateway = await startGatewayWithClient({
          cfg: {
            agents: {
              defaults: {
                workspace: workspaceDir,
                skipBootstrap: true,
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
                sandbox: {
                  mode: "all",
                  backend: "docker",
                  workspaceAccess: "ro",
                  workspaceRoot: path.join(tempHome, "sandboxes"),
                  browser: { enabled: false },
                },
              },
              entries: { main: { default: true } },
            },
            models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
            gateway: { auth: { token } },
          },
          configPath,
          token,
          clientDisplayName: "foreground-cleanup",
          onEvent: (event) => {
            const payload = asOptionalRecord(event.payload);
            if (
              event.event === "chat" &&
              typeof payload?.runId === "string" &&
              typeof payload.state === "string" &&
              typeof payload.seq === "number"
            ) {
              events.push({
                runId: payload.runId,
                state: payload.state,
                seq: payload.seq,
                errorMessage:
                  typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
              });
            }
          },
        });
        const { client, server } = gateway;
        await server.startupSettled;
        await upsertSessionEntryCore(scope, {
          sessionId,
          lifecycleRevision: nextGatewayId("foreground-revision"),
          updatedAt: Date.now(),
          execution: "foreground-only",
          sandbox: "required",
        });
        const send = {
          sessionKey,
          message: "Wait for my next instruction.",
          idempotencyKey: nextGatewayId("foreground-run"),
        };
        const started = await client.request<{ runId: string; status: string }>("chat.send", send);
        expect(started).toMatchObject({ runId: send.idempotencyKey, status: "started" });
        await withinTest(entered[0].promise, signal);
        admissionRelease = expectDefined(
          getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] }),
          "real foreground session admission",
        );
        let admissionReleased = false;
        void admissionRelease.then(() => {
          admissionReleased = true;
        });
        const allocation = expectDefined(
          (await readRegistry()).entries.find((entry) => entry.foreground?.runId === started.runId),
          "real foreground allocation receipt",
        );
        expect(allocation).toMatchObject({
          runtimeState: "ready",
          foreground: {
            containerId: expect.stringMatching(/^[a-f0-9]{64}$/),
            startAttempted: true,
          },
        });
        const draftPath = path.join(
          expectDefined(allocation.workspaceDir, "retained sandbox workspace"),
          "draft.txt",
        );
        await fs.writeFile(draftPath, "retained draft");
        const aborted = await client.request("chat.abort", { sessionKey, runId: started.runId });
        expect(aborted).toMatchObject({ ok: true, aborted: true });
        await withinTest(transport.reachedWait.promise, signal);
        await expect
          .poll(() =>
            events.find((event) => event.runId === started.runId && event.state === "aborted"),
          )
          .toBeDefined();
        const initial = expectDefined(
          events.find((event) => event.runId === started.runId && event.state === "aborted"),
          "Stop frame",
        );
        expect(initial.errorMessage).toBeUndefined();
        expect(admissionReleased).toBe(false);
        expect(transport.commands).not.toContain("rm");
        expect(await readRegistryEntry(allocation.containerName)).not.toBeNull();
        await expect.poll(() => loadSessionEntry(scope)?.status).toBe("killed");
        const stopped = expectDefined(loadSessionEntry(scope), "persisted Stop");
        expect(stopped.endedAt).toEqual(expect.any(Number));
        transport.releaseWait.resolve();
        await withinTest(admissionRelease, signal);
        expect(admissionReleased).toBe(true);
        if (failWait) {
          await expect
            .poll(
              () =>
                events.filter(
                  (event) =>
                    event.runId === started.runId &&
                    event.errorMessage?.includes("Command cleanup could not confirm"),
                ).length,
            )
            .toBe(1);
          const late = expectDefined(
            events.find((event) => event.runId === started.runId && event.errorMessage),
            "late cleanup frame",
          );
          expect(late.state).toBe("aborted");
          expect(late.seq).toBeGreaterThan(initial.seq);
          expect(transport.commands).not.toContain("rm");
          await expect
            .poll(() => loadSessionEntry(scope)?.lastRunError)
            .toContain("Command cleanup could not confirm");
          expect(loadSessionEntry(scope)).toMatchObject({
            status: "killed",
            startedAt: stopped.startedAt,
            endedAt: stopped.endedAt,
          });
          expect(await readRegistryEntry(allocation.containerName)).toMatchObject({
            foreground: { containerId: allocation.foreground?.containerId, cleanupUncertain: true },
          });
          await expect(client.request("chat.send", send)).rejects.toMatchObject({
            message: expect.stringContaining("Command cleanup could not confirm"),
            responsePayload: {
              runId: started.runId,
              status: "timeout",
              stopReason: "rpc",
              endedAt: stopped.endedAt,
            },
          });
        } else {
          expect(await readRegistryEntry(allocation.containerName)).toBeNull();
          expect(
            events
              .filter((event) => event.runId === started.runId)
              .map((event) => event.errorMessage)
              .filter(Boolean),
          ).toEqual([]);
          await expect(client.request("chat.send", send)).resolves.toMatchObject({
            runId: started.runId,
            status: "timeout",
            stopReason: "rpc",
            endedAt: stopped.endedAt,
          });
        }
        const waited = await client.request("agent.wait", { runId: started.runId, timeoutMs: 0 });
        expect(waited).toMatchObject({
          stopReason: "rpc",
          endedAt: stopped.endedAt,
          ...(failWait
            ? {
                status: "error",
                error: expect.stringContaining("Command cleanup could not confirm"),
              }
            : {}),
        });
        expect(providerRequests).toBe(1);
        expect(transport.commands.filter((command) => command === "create")).toHaveLength(1);
        const next = await client.request<{ runId: string }>("chat.send", {
          ...send,
          idempotencyKey: nextGatewayId("foreground-next"),
        });
        if (failWait) {
          const rejected = await client.request(
            "agent.wait",
            { runId: next.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );
          expect(rejected).toMatchObject({ status: "error" });
          expect(providerRequests).toBe(1);
          expect(transport.commands.filter((command) => command === "create")).toHaveLength(1);
          expect(await readRegistryEntry(allocation.containerName)).toMatchObject({
            foreground: { cleanupUncertain: true },
          });
        } else {
          await withinTest(entered[1].promise, signal);
          admissionRelease = expectDefined(
            getSessionWorkAdmissionRelease({
              scope: storePath,
              identities: [sessionKey, sessionId],
            }),
            "second foreground admission",
          );
          expect(providerRequests).toBe(2);
          expect(transport.commands.filter((command) => command === "create")).toHaveLength(2);
          await client.request("chat.abort", { sessionKey, runId: next.runId });
          await withinTest(admissionRelease, signal);
          expect((await readRegistry()).entries).toEqual([]);
        }
        expect(await fs.readFile(draftPath, "utf8")).toBe("retained draft");
      },
      async () => {
        transport.releaseWait.resolve();
        if (gateway) {
          await gateway.client.request("chat.abort", { sessionKey });
        }
        await admissionRelease;
      },
      async () => {
        if (gateway) await disconnectGatewayClient(gateway.client);
      },
      async () => {
        await gateway?.server.close({ reason: "foreground cleanup fixture complete" });
      },
      async () => {
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      },
    );
  },
);
