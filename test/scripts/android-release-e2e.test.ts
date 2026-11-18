import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { commit, git, initGit } from "./mobile-release-git.test-support.js";

const mocks = vi.hoisted(() => ({ repo: "", command: vi.fn(), gateway: vi.fn(), rpc: vi.fn() }));
vi.mock("../../scripts/lib/repo-root.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/repo-root.mjs")>()),
  resolveRepoRoot: () => mocks.repo,
}));
vi.mock("../../scripts/lib/managed-child-process.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mjs")>()),
  runManagedCommand: mocks.command,
}));
vi.mock("../../scripts/lib/ios-release-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/ios-release-gateway.js")>()),
  prepareIOSReleaseGateway: mocks.gateway,
}));
vi.mock("../../src/gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/gateway/call.js")>()),
  callGateway: mocks.rpc,
}));
vi.mock("../helpers/openclaw-test-instance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../helpers/openclaw-test-instance.js")>()),
  createOpenClawTestInstance: async () => ({
    startGateway: async () => {},
    cleanup: async () => {},
    logs: () => "",
    url: "ws://127.0.0.1:12345",
    port: 12345,
    configPath: "/synthetic/config.json",
    gatewayToken: "synthetic",
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const suiteDirs = useAutoCleanupTempDirTracker(afterAll);
let main: typeof import("../../scripts/android-release-e2e.js").main;
let candidateSha: string;
const originalExitCode = process.exitCode;
function checkout(root: string) {
  initGit(root, { name: "Fixture", email: "fixture@example.invalid" });
  writeFileSync(path.join(root, ".gitignore"), "apps/android/**/build/\n");
  writeFileSync(path.join(root, "identity.txt"), path.basename(root));
  return commit(root, "fixture");
}
beforeAll(async () => {
  mocks.repo = path.join(suiteDirs.make("android-release-suite-"), "candidate");
  candidateSha = checkout(mocks.repo);
  main = (await import("../../scripts/android-release-e2e.js")).main;
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.command.mockReset();
  mocks.gateway.mockReset();
  mocks.rpc.mockReset();
});
const tag = "v2026.11.17";
function argv(output: string, root?: string, sha?: string) {
  return [
    "--target-sha",
    candidateSha,
    "--output",
    output,
    ...(root ? ["--client-root", root, "--client-sha", sha!, "--client-release-tag", tag] : []),
  ];
}
it.each([
  ["--client-root", "client"],
  ["--client-sha", "a".repeat(40)],
  ["--client-release-tag", tag],
  ["--client-root", "client", "--client-sha", "short", "--client-release-tag", tag],
  [
    "--client-root",
    "client",
    "--client-sha",
    "a".repeat(40),
    "--client-release-tag",
    "v2026.11.17-beta.1",
  ],
])("rejects incomplete or invalid compatibility arguments %j", async (...args) => {
  await expect(main([...argv("unused.json"), ...args])).rejects.toThrow("required together");
  expect(mocks.command).not.toHaveBeenCalled();
});
it.each([
  ["--candidate-root", "."],
  ["--harness-sha", "a".repeat(40)],
])("rejects independent roots outside stable-client compatibility %j", async (...args) => {
  await expect(main([...argv("unused.json"), ...args])).rejects.toThrow(
    "require stable-client compatibility",
  );
  expect(mocks.command).not.toHaveBeenCalled();
});
it("rejects the candidate checkout as the stable client", async () => {
  await expect(main(argv("unused.json", mocks.repo, candidateSha))).rejects.toThrow(
    "separate stable-release checkout",
  );
});
it.each([
  "compatibility",
  "default",
  "dirty-client",
  "wrong-client-head",
  "changed-client",
  "separate-candidate",
  "candidate-mismatch",
  "candidate-missing",
])(
  "keeps native build/source/Gateway identities separate and fixture lifecycle rooted in the harness for %s",
  async (scenario) => {
    const root = tempDirs.make("android-release-client-");
    const separateCandidate = scenario.includes("candidate");
    const candidateRoot = separateCandidate ? path.join(root, "gateway-candidate") : mocks.repo;
    const targetSha =
      separateCandidate && scenario !== "candidate-missing"
        ? checkout(candidateRoot)
        : candidateSha;
    if (separateCandidate && scenario !== "candidate-missing") {
      mkdirSync(path.join(candidateRoot, "dist"));
      writeFileSync(
        path.join(candidateRoot, "dist/build-info.json"),
        JSON.stringify({ commit: targetSha }),
      );
      // Build output is ignored just as it is in a prepared candidate checkout.
      writeFileSync(path.join(candidateRoot, ".git/info/exclude"), "dist/\n");
    }
    const client = path.join(root, "stable");
    const clientSha = checkout(client);
    git(client, "tag", tag);
    const sdk = path.join(root, "sdk");
    mkdirSync(path.join(sdk, "build-tools/36"), { recursive: true });
    vi.stubEnv("ANDROID_HOME", sdk);
    vi.stubEnv("GITHUB_ACTIONS", "false");
    vi.stubGlobal(
      "process",
      Object.defineProperties(Object.create(process), {
        platform: { value: "darwin" },
        arch: { value: "arm64" },
        umask: { value: vi.fn().mockReturnValue(0o077) },
      }),
    );
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    const buildRoot = scenario === "default" ? mocks.repo : client;
    if (scenario === "dirty-client") {
      // The candidate has no such file: mixed-root hashing cannot read it.
      writeFileSync(path.join(client, "stable-only.txt"), "untracked stable content");
    }
    const counters = new Map<string, number>();
    const launchedFrom: string[] = [];
    const apkPaths: string[] = [];
    mocks.gateway.mockImplementation(async (options) => {
      if (separateCandidate) {
        const actual = await vi.importActual<
          typeof import("../../scripts/lib/ios-release-gateway.js")
        >("../../scripts/lib/ios-release-gateway.js");
        return actual.prepareIOSReleaseGateway(options);
      }
      return {
        cwd: options.candidateDir ?? "/synthetic/published-gateway",
        entrypoint: ["openclaw.mjs"],
        identity: { targetSha: options.targetSha },
      };
    });
    mocks.rpc.mockImplementation(async () => {
      if (scenario === "changed-client") {
        writeFileSync(path.join(client, "changed.txt"), "changed after build");
      }
      return { setupCode: "synthetic-setup" };
    });
    const serialRoles = new Map<string, string>();
    const phasePids = new Map<string, number>();
    const finishes = new Map<string, () => void>();
    const traffic = Object.fromEntries(
      ["request", "response", "event"].map((kind) => ["/openclaw/wear/v1/" + kind, 1]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const role = url.includes(":4001/") ? "phone" : "wear";
        if (url.endsWith("/finish")) {
          finishes.get(role)?.();
        }
        return {
          ok: true,
          json: async () => ({
            role,
            nodeId: "release-" + role,
            pid: phasePids.get(role),
            healthy: true,
            inbound: traffic,
            outbound: traffic,
          }),
        };
      }),
    );
    mocks.command.mockImplementation(async (options) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        stdin: new PassThrough(),
      });
      options.onReady?.(child);
      const emit = (text: string) => stdout.write(text);
      const args: string[] = options.args;
      if (options.bin === "git") {
        emit(execFileSync("git", args, { cwd: options.cwd, encoding: "utf8" }));
      } else if (args.includes("scripts/run-android-gradle.mts")) {
        launchedFrom.push(options.cwd);
        for (const relative of [
          "app/build/outputs/apk/play/debug",
          "app/build/outputs/apk/androidTest/play/debug",
          "wear/build/outputs/apk/debug",
          "wear/build/outputs/apk/androidTest/debug",
        ]) {
          const directory = path.join(options.cwd, "apps/android", relative);
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            path.join(directory, "output-metadata.json"),
            JSON.stringify({ elements: [{ outputFile: "fixture.apk" }] }),
          );
          writeFileSync(path.join(directory, "fixture.apk"), relative);
        }
      } else if (path.basename(options.bin) === "aapt2") {
        const apk = args.find((arg) => arg.endsWith(".apk"))!;
        apkPaths.push(apk);
        emit(
          args.includes("badging")
            ? "package: name='ai.openclaw.app.debug' versionCode='" +
                (apk.includes("/wear/") ? 2 : 1) +
                "' versionName='fixture'"
            : "WearProxyListenerService",
        );
      } else if (path.basename(options.bin) === "apksigner") {
        emit("Signer #1 certificate SHA-256 digest: " + "a".repeat(64));
      } else if (options.env.MOCK_REQUEST_LOG) {
        const markers = [
          "PHONE_FIRST",
          "PHONE_SECOND",
          "WEAR_FIRST",
          "WEAR_SECOND",
          "WEAR_RELAUNCH",
          "PHONE_RELAUNCH",
          "PHONE_RESTART",
          "LONG_REPLY",
        ];
        writeFileSync(
          options.env.MOCK_REQUEST_LOG,
          markers
            .map((marker) =>
              JSON.stringify({
                path: "/v1/responses",
                body: JSON.stringify({
                  model: "android-e2e",
                  input: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text:
                            "This is Android release validation. Reply with exactly: OPENCLAW_E2E_ANDROID_" +
                            marker,
                        },
                      ],
                    },
                  ],
                }),
              }),
            )
            .join("\n"),
        );
        emit("mock-openai listening on 34567");
        return new Promise<number>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(0), { once: true });
        });
      } else if (path.basename(options.bin) === "emulator" && args.includes("-avd")) {
        serialRoles.set(
          "emulator-" + args[args.indexOf("-port") + 1],
          args[args.indexOf("-avd") + 1] === "release-phone" ? "phone" : "wear",
        );
        return new Promise<number>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(0), { once: true });
        });
      } else if (args.includes("sys.boot_completed")) {
        emit("1");
      } else if (args.includes("avd") && args.includes("name")) {
        emit(
          args.some((arg) => serialRoles.get(arg) === "phone") ? "release-phone" : "release-wear",
        );
      } else if (args.some((arg) => arg.includes("virtio_transport_max_vsock_pkt_buf_size"))) {
        emit("16384");
      } else if (args.includes("tcp:0")) {
        emit(args.some((arg) => serialRoles.get(arg) === "phone") ? "4001" : "4002");
      } else if (args.includes("instrument")) {
        const role = args.some((arg) => serialRoles.get(arg) === "phone") ? "phone" : "wear";
        const count = (counters.get(role) ?? 0) + 1;
        counters.set(role, count);
        phasePids.set(role, count);
        emit(
          ["initial", "relaunch", "phone-restart", "long-reply", "reader"]
            .map((phase) => "OPENCLAW_ANDROID_PHASE_READY " + phase)
            .join("\n"),
        );
        return new Promise<number>((resolve) => {
          finishes.set(role, () => {
            emit("OK (1 test)");
            resolve(0);
          });
        });
      }
      return 0;
    });
    const output = path.join(root, "proof.json");
    const proof = await main([
      ...argv(
        output,
        scenario === "default" ? undefined : client,
        scenario === "wrong-client-head" ? "0".repeat(40) : clientSha,
      ),
      ...(scenario === "dirty-client" ? ["--allow-dirty"] : []),
      ...(separateCandidate
        ? [
            "--candidate-root",
            candidateRoot,
            "--harness-sha",
            candidateSha,
            "--target-sha",
            scenario === "candidate-mismatch" ? "0".repeat(40) : targetSha,
          ]
        : []),
    ]);
    if (["candidate-mismatch", "candidate-missing"].includes(scenario)) {
      expect(proof.status).toBe("failed");
      expect(proof.failure).toBe("gateway-install");
      expect(counters.size).toBe(0);
    } else if (["dirty-client", "wrong-client-head"].includes(scenario)) {
      expect(proof.status).toBe("failed");
      expect(proof.failure).toBe("source");
      expect(launchedFrom).toEqual([]);
      if (scenario === "dirty-client") {
        expect(proof.client?.source).toMatchObject({
          clean: false,
          diffSha256: expect.any(String),
        });
      }
    } else {
      expect(launchedFrom).toEqual([buildRoot]);
      expect(apkPaths.length).toBeGreaterThan(0);
      expect(apkPaths.every((apk) => apk.startsWith(buildRoot + path.sep))).toBe(true);
      expect(proof.status).toBe(scenario === "changed-client" ? "failed" : "passed");
      if (scenario === "changed-client") {
        expect(proof.failure).toBe("provider-evidence");
      }
      expect(proof.cleanupConfirmed).toBe(true);
      const options = mocks.gateway.mock.calls[0]![0];
      expect(options.targetSha).toBe(targetSha);
      expect(options.candidateDir).toBe(scenario === "default" ? undefined : candidateRoot);
    }
    expect(proof.targetSha).toBe(scenario === "candidate-mismatch" ? "0".repeat(40) : targetSha);
    expect(proof.harnessSha).toBe(candidateSha);
    if (scenario === "separate-candidate") {
      expect(targetSha).not.toBe(candidateSha);
      expect(proof.gateway).toEqual({ kind: "candidate-source", targetSha, sourceSha: targetSha });
      const provider = mocks.command.mock.calls
        .map(([options]) => options)
        .find((options) => options.env?.MOCK_REQUEST_LOG);
      expect(provider.cwd).toBe(mocks.repo);
    }
    expect(proof.client).toEqual(
      scenario === "default"
        ? undefined
        : {
            kind: "stable-release-source-rebuild",
            clientSha: scenario === "wrong-client-head" ? "0".repeat(40) : clientSha,
            releaseTag: tag,
            source:
              scenario === "dirty-client"
                ? { clean: false, diffSha256: expect.any(String) }
                : { clean: scenario !== "wrong-client-head" },
          },
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(proof);
  },
);
