import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertMilestoneGates,
  createMilestoneGates,
  redactSmokeUrl,
  resolveSnesStudioSmokeBrowserExecutable,
  type MilestoneGate,
} from "../../scripts/dev/control-ui-snes-studio-smoke.js";
import {
  buildGlm52LocalProviderConfig,
  buildPromotedAgentsList,
  determineGlm52BenchmarkPromotions,
  localGlm52ProviderModelRef,
  parseGlm52RuntimeArgs,
  runGlm52AgentProof,
  runGlm52Runtime,
  safeStopGlm52Runtime,
  scoreGlm52AgentProof,
  startGlm52Runtime,
} from "../../scripts/lib/glm52-local-runtime.mjs";
import {
  createSnesLocalModelBenchmarkReport,
  createSnesOutputBenchmarkReport,
  renderBenchmarkSummaryMarkdown,
  scoreSnesOutputBenchmarkResponse,
  SNES_BENCHMARK_TASKS,
  discoverLocalLlamaCppGlmModels,
  probeLocalLlamaCppGlmRuntime,
  writeBenchmarkArtifacts,
} from "../../scripts/lib/snes-local-model-benchmark.mjs";

const externalProof = {
  emulators: {
    required: ["ares", "bsnes", "mesen", "snes9x"],
    detected: [],
    blocked: true,
    blocker: "No supported emulator executable was found on PATH or in /Applications.",
  },
  fxpak: {
    detectedVolumes: [],
    blocked: true,
    blocker: "No mounted FXPAK PRO or SD2SNES-style FAT32 volume was found under /Volumes.",
  },
  liveAgent: {
    ready: true,
    configured: false,
    e2eEnabled: false,
    blocked: false,
    blocker: null,
    note: "Live agents are ready; automated E2E was skipped because OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E is not set.",
  },
};

describe("control-ui-snes-studio-smoke milestone gates", () => {
  it("creates exactly ten sequential verified gates with concrete evidence", () => {
    const gates = createMilestoneGates({
      screenshots: [
        "desktop-make.png",
        "desktop-arrange.png",
        "desktop-ship.png",
        "mobile-play.png",
      ],
      downloads: ["game.sfc", "game.oc-snes.json", "game.oc-snes-bundle.json"],
      externalProof,
    });

    expect(gates.map((gate) => gate.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(gates.every((gate) => gate.status === "verified")).toBe(true);
    expect(gates.every((gate) => gate.evidence.length > 0)).toBe(true);
    expect(gates[2]?.evidence).toContain("Create screen checked for no hidden legacy cockpit.");
    expect(gates[2]?.evidence).toContain(
      "Create screen checked for no first-screen full professional workbench.",
    );
    expect(gates[7]?.evidence).toContain(externalProof.emulators.blocker);
    expect(gates[7]?.evidence).toContain(externalProof.liveAgent.note);
    expect(() => assertMilestoneGates(gates)).not.toThrow();
  });

  it("rejects missing or out-of-order milestone gate proof", () => {
    const gates = createMilestoneGates({
      screenshots: [
        "desktop-make.png",
        "desktop-arrange.png",
        "desktop-ship.png",
        "mobile-play.png",
      ],
      downloads: ["game.sfc", "game.oc-snes.json", "game.oc-snes-bundle.json"],
      externalProof,
    });
    const outOfOrder: MilestoneGate[] = [gates[1], gates[0], ...gates.slice(2)];
    const missingEvidence: MilestoneGate[] = gates.map((gate) =>
      gate.id === 5 ? { ...gate, evidence: [] } : gate,
    );

    expect(() => assertMilestoneGates(outOfOrder)).toThrow("milestone gates incomplete");
    expect(() => assertMilestoneGates(missingEvidence)).toThrow("milestone gates incomplete");
    expect(() => assertMilestoneGates(gates.slice(0, 9))).toThrow("milestone gates incomplete");
  });

  it("redacts dashboard tokens from smoke summary URLs", () => {
    expect(redactSmokeUrl("https://gateway.example.test/snes-studio?x=1#token=super-secret")).toBe(
      "https://gateway.example.test/snes-studio?x=1#token=%5Bredacted%5D",
    );
    expect(redactSmokeUrl("https://gateway.example.test/snes-studio?token=super-secret&x=1")).toBe(
      "https://gateway.example.test/snes-studio?token=%5Bredacted%5D&x=1",
    );
    expect(redactSmokeUrl("not-a-url#token=super-secret")).toBe("not-a-url#token=[redacted]");
  });

  it("fails closed when Playwright Chromium is missing and system fallback is not explicit", () => {
    expect(() =>
      resolveSnesStudioSmokeBrowserExecutable(
        {},
        (path) => path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    ).toThrow("SNES Studio browser proof blocked: Playwright bundled Chromium is missing");
  });

  it("uses a system browser only when explicitly allowed", () => {
    expect(
      resolveSnesStudioSmokeBrowserExecutable(
        { OPENCLAW_CONTROL_UI_SMOKE_ALLOW_SYSTEM_BROWSER: "1" },
        (path) => path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    ).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("detects local GLM only after a llama.cpp decode probe succeeds", () => {
    const missing = discoverLocalLlamaCppGlmModels(() => ({
      error: new Error("offline"),
      status: 1,
      stdout: "",
    }));
    expect(missing).toEqual([]);

    const requestedUrls: string[] = [];
    const spawn = (command: string, args: readonly string[]) => {
      expect(command).toBe("curl");
      requestedUrls.push(args.at(-1) ?? "");
      if (String(args.at(-1)).endsWith("/v1/models")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            data: [{ id: "unsloth/GLM-5.2-GGUF:UD-IQ1_S" }],
          }),
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
      };
    };
    const installed = discoverLocalLlamaCppGlmModels(spawn, "http://127.0.0.1:18080/");
    expect(requestedUrls).toEqual([
      "http://127.0.0.1:18080/v1/models",
      JSON.stringify({
        max_tokens: 32,
        messages: [{ content: 'Return JSON only: {"ok":true}', role: "user" }],
        model: "unsloth/GLM-5.2-GGUF:UD-IQ1_S",
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    ]);
    expect(installed).toEqual(["local-glm-5.2-2bit"]);

    const report = createSnesLocalModelBenchmarkReport({
      generatedAt: "2026-06-21T00:00:00.000Z",
      installedModelRefs: installed,
      noDownload: true,
    });
    expect(report.downloadsAttempted).toBe(false);
    expect(report.hostedProvidersUsed).toBe(false);
    expect(report.installedModelRefs).toContain("local-glm-5.2-2bit");
  });

  it("blocks local GLM when llama.cpp lists the model but decode returns compute error", () => {
    const diagnostic = probeLocalLlamaCppGlmRuntime(
      (command, args) => {
        expect(command).toBe("curl");
        if (String(args.at(-1)).endsWith("/v1/models")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              data: [{ id: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf" }],
            }),
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            error: { code: 500, message: "Compute error.", type: "server_error" },
          }),
        };
      },
      { baseUrl: "http://127.0.0.1:18080" },
    );

    expect(diagnostic.listed).toBe(true);
    expect(diagnostic.decodeReady).toBe(false);
    expect(diagnostic.blocker).toBe("Compute error.");

    const report = createSnesOutputBenchmarkReport({
      defaultModelsByRole: { "snes-game-director": "ollama/openclaw-control-qwen25-32b:latest" },
      generatedAt: "2026-06-22T00:00:00.000Z",
      installedModelRefs: ["ollama/openclaw-control-qwen25-32b:latest"],
      localModelDiagnostics: { "local-glm-5.2-2bit": diagnostic },
      candidateModelRefs: ["local-glm-5.2-2bit"],
      roles: ["snes-game-director"],
      timeoutSeconds: 30,
    });
    const glm = report.results.find((result) => result.modelRef === "local-glm-5.2-2bit");
    expect(glm?.available).toBe(false);
    expect(glm?.status).toBe("blocked");
    expect(glm?.blocker).toContain("local GLM listed but decode blocked: Compute error.");
    expect(report.localModelDiagnostics["local-glm-5.2-2bit"].decodeReady).toBe(false);
  });

  it("uses the GLM runtime port by default for benchmark discovery", () => {
    const requestedUrls: string[] = [];
    probeLocalLlamaCppGlmRuntime((command, args) => {
      expect(command).toBe("curl");
      requestedUrls.push(String(args.at(-1)));
      return { status: 1, stderr: "offline", stdout: "" };
    });

    expect(requestedUrls[0]).toBe("http://127.0.0.1:28080/v1/models");
  });

  it("reports offline local GLM as a runtime blocker when model files are present", () => {
    const report = createSnesOutputBenchmarkReport({
      candidateModelRefs: ["local-glm-5.2-2bit"],
      generatedAt: "2026-06-24T00:00:00.000Z",
      installedModelRefs: [],
      localModelDiagnostics: {
        "local-glm-5.2-2bit": {
          baseUrl: "http://127.0.0.1:28080",
          blocker: "connection refused",
          decodeReady: false,
          listed: false,
          modelFilesPresent: true,
          status: "offline",
        },
      },
      roles: ["snes-hardware-qa"],
      timeoutSeconds: 30,
    });
    const glm = report.results.find((result) => result.modelRef === "local-glm-5.2-2bit");
    expect(glm?.blocker).toContain("local GLM model files exist");
    expect(glm?.blocker).toContain("llama.cpp endpoint is offline");
    expect(glm?.blocker).not.toContain("not installed locally");
  });

  it("safely refuses to stop non-llama-server processes on the GLM port", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnSyncFn = (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      if (command === "lsof") {
        return { status: 0, stdout: "1234\n" };
      }
      if (command === "ps") {
        return { status: 0, stdout: "/usr/bin/python3 -m http.server 28080" };
      }
      return { status: 0, stdout: "" };
    };

    const result = safeStopGlm52Runtime({ port: 28080, spawnSyncFn });
    expect(result.ok).toBe(false);
    expect(result.stopped).toEqual([]);
    expect(result.refused[0]?.reason).toBe("port owner is not llama-server");
    expect(calls.some((call) => call.command === "kill")).toBe(false);
  });

  it("uses lsof process-name fallback when ps output is sandbox-blocked", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnSyncFn = (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      if (command === "lsof" && args.includes("-t")) {
        return { status: 0, stdout: "1234\n" };
      }
      if (command === "ps") {
        return { status: 1, stdout: "", stderr: "operation not permitted" };
      }
      if (command === "lsof" && args.includes("-F")) {
        return { status: 0, stdout: "cllama-server\n" };
      }
      if (command === "kill") {
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    };

    const result = safeStopGlm52Runtime({ port: 28080, spawnSyncFn });
    expect(result.ok).toBe(true);
    expect(result.stopped[0]?.command).toBe("llama-server");
    expect(calls.some((call) => call.command === "kill")).toBe(true);
  });

  it("starts llama-server with durable file-backed stdio instead of short-lived pipes", () => {
    const runDir = mkdtempSync(join(tmpdir(), "glm52-runtime-"));
    const modelPath = join(runDir, "model.gguf");
    const context = { baseUrl: "http://127.0.0.1:28080", runDir, stamp: "test" };
    const seen: { stdio?: unknown[] } = {};
    try {
      rmSync(modelPath, { force: true });
      // Minimal existing file; the launcher only verifies existence before spawning.
      writeFileSync(modelPath, "");
      const result = startGlm52Runtime(
        {
          host: "127.0.0.1",
          llamaServer: "llama-server",
          modelPath,
          port: 28080,
        },
        { args: [], contextSize: 512, id: "test-profile" },
        {
          context,
          spawnFn: (_command, _args, options) => {
            seen.stdio = options.stdio;
            return { pid: 1234, unref() {} };
          },
          spawnSyncFn: (command) => {
            if (command === "lsof") return { status: 1, stdout: "" };
            return { status: 0, stdout: "" };
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(seen.stdio?.[0]).toBe("ignore");
      expect(typeof seen.stdio?.[1]).toBe("number");
      expect(typeof seen.stdio?.[2]).toBe("number");
      expect(readFileSync(join(runDir, "runtime-process.json"), "utf8")).toContain('"pid": 1234');
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  it("parses durable verification runtime arguments", () => {
    const args = parseGlm52RuntimeArgs([
      "verify-durable",
      "--duration-seconds",
      "12",
      "--interval-seconds",
      "3",
    ]);
    expect(args.command).toBe("verify-durable");
    expect(args.verifyDurationSeconds).toBe(12);
    expect(args.verifyIntervalSeconds).toBe(3);
  });

  it("tries GLM repair profiles in order and stops on first decode-ready profile", async () => {
    const probeResponses = [
      { error: { code: 500, message: "Compute error.", type: "server_error" } },
      { choices: [{ message: { content: '{"ok":true}' } }] },
    ];
    const spawnedProfiles: string[] = [];
    const spawnFn = (_command: string, args: readonly string[]) => {
      const profile = args.includes("--no-mmap")
        ? "metal-no-mmap"
        : args.includes("-ngl")
          ? "cpu-safe"
          : "metal-low";
      spawnedProfiles.push(profile);
      return {
        pid: 4321,
        stderr: { on() {} },
        stdout: { on() {} },
        unref() {},
      };
    };
    const spawnSyncFn = (command: string, args: readonly string[]) => {
      if (command === "lsof") return { status: 1, stdout: "" };
      if (command === "vm_stat") return { status: 0, stdout: "Pages free: 1" };
      if (command === "llama-server") return { status: 0, stdout: "version: test" };
      if (command === "curl" && String(args.at(-1)).endsWith("/v1/models")) {
        return {
          status: 0,
          stdout: JSON.stringify({ data: [{ id: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf" }] }),
        };
      }
      if (command === "curl") {
        const response = probeResponses.shift() ?? probeResponses.at(-1);
        return { status: 0, stdout: JSON.stringify(response) };
      }
      if (command === "kill") return { status: 0, stdout: "" };
      if (command === "ps") return { status: 0, stdout: "llama-server" };
      return { status: 0, stdout: "" };
    };

    const report = await runGlm52Runtime(
      {
        artifactDir: ".artifacts/test-glm52-runtime",
        command: "repair",
        contextSize: 512,
        host: "127.0.0.1",
        json: true,
        llamaServer: "llama-server",
        maxOutputTokens: 32,
        modelPath: "package.json",
        port: 28080,
        settleMs: 0,
        timeoutSeconds: 30,
      },
      { spawnFn, spawnSyncFn, sleep: async () => {} },
    );

    expect(spawnedProfiles).toEqual(["metal-low", "metal-no-mmap"]);
    expect(report.diagnostic.decodeReady).toBe(true);
    expect(report.profile).toBe("metal-no-mmap");
    expect(report.attempts.map((attempt) => attempt.profile)).toEqual([
      "metal-low",
      "metal-no-mmap",
    ]);
  });

  it("builds a local-only OpenAI-compatible GLM provider config", () => {
    const config = buildGlm52LocalProviderConfig({
      baseUrl: "http://127.0.0.1:28080/",
      contextSize: 512,
      maxOutputTokens: 256,
      modelId: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
      providerTimeoutSeconds: 900,
    });

    expect(config).toMatchObject({
      api: "openai-completions",
      apiKey: "openclaw-local-glm52",
      baseUrl: "http://127.0.0.1:28080/v1",
      request: { allowPrivateNetwork: true },
      timeoutSeconds: 900,
    });
    expect(config.models[0]).toMatchObject({
      id: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
      compat: {
        requiresStringContent: true,
        supportsStrictMode: false,
        supportsTools: false,
      },
      contextWindow: 512,
      maxTokens: 256,
    });
    expect(localGlm52ProviderModelRef()).toBe("local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf");
  });

  it("promotes only clean benchmark-winning GLM roles and preserves fallbacks", () => {
    const defaultModel = "ollama/openclaw-control-qwen25-32b:latest";
    const report = {
      currentDefaultsByRole: { "snes-hardware-qa": defaultModel },
      downloadsAttempted: false,
      hostedGlmUsed: false,
      modelSummaries: [
        {
          availableRuns: 3,
          blockedRuns: 0,
          failedRuns: 0,
          invalidJsonRuns: 0,
          meanScore: 90,
          modelRef: "local-glm-5.2-2bit",
          role: "snes-hardware-qa",
        },
      ],
      promotionRecommendationsByRole: {
        "snes-hardware-qa": {
          currentDefault: defaultModel,
          readyToPromote: true,
          recommendedModel: "local-glm-5.2-2bit",
        },
      },
      recommendedWinnersByRole: {
        "snes-game-director": defaultModel,
        "snes-hardware-qa": "local-glm-5.2-2bit",
      },
    };

    const plan = determineGlm52BenchmarkPromotions(report, {
      modelId: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
      roles: ["snes-hardware-qa"],
    });
    expect(plan.blocker).toBeNull();
    expect(plan.promotions).toHaveLength(1);
    expect(plan.promotions[0]?.model).toEqual({
      primary: "local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
      fallbacks: [defaultModel],
    });

    const agentsList = buildPromotedAgentsList(
      [
        { id: "snes-game-director", model: defaultModel },
        { id: "snes-hardware-qa", model: defaultModel },
      ],
      plan.promotions,
    );
    expect(agentsList).toEqual([
      { id: "snes-game-director", model: defaultModel },
      {
        id: "snes-hardware-qa",
        model: {
          primary: "local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
          fallbacks: [defaultModel],
        },
      },
    ]);
  });

  it("rejects local GLM promotion when the benchmark used hosted GLM or downloads", () => {
    const hosted = determineGlm52BenchmarkPromotions({
      downloadsAttempted: false,
      hostedGlmUsed: true,
      recommendedWinnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
    });
    expect(hosted.promotions).toEqual([]);
    expect(hosted.blocker).toContain("hosted GLM");

    const downloaded = determineGlm52BenchmarkPromotions({
      downloadsAttempted: true,
      hostedGlmUsed: false,
      recommendedWinnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
    });
    expect(downloaded.promotions).toEqual([]);
    expect(downloaded.blocker).toContain("downloads");
  });

  it("scores GLM agent proof fail-closed on hardware terms and safe patch paths", () => {
    const invalid = scoreGlm52AgentProof("not json");
    expect(invalid.ok).toBe(false);
    expect(invalid.blockers[0]).toContain("parseable JSON");

    const unsafe = scoreGlm52AgentProof(
      JSON.stringify({
        role: "snes-hardware-qa",
        changedSurface: "hardware qa",
        content: "ROM SRAM VRAM CGRAM ARAM FXPAK SuperFX checksum FAT32 ready",
        constraintsRespected: ["SNES safe", "local GLM"],
        playtestHypothesis: "Boot and save are checked in the first 30 seconds.",
        riskBlocker: "none",
        patch: [{ op: "replace", path: "/packageJson/scripts/postinstall", value: "bad" }],
        receipt: ["checked hardware", "kept local"],
      }),
    );
    expect(unsafe.ok).toBe(false);
    expect(unsafe.blockers).toContain("missing or unsafe SNES Studio patch");

    const safe = scoreGlm52AgentProof(
      JSON.stringify({
        role: "snes-hardware-qa",
        changedSurface: "settings/export/hardwareQa",
        content: "ROM SRAM VRAM CGRAM ARAM FXPAK SuperFX checksum FAT32 ready",
        constraintsRespected: ["SNES safe", "local GLM"],
        playtestHypothesis: "Boot and save are checked in the first 30 seconds.",
        riskBlocker: "none",
        patch: [{ op: "replace", path: "/settings/export/hardwareQa", value: "ready" }],
        receipt: ["checked hardware", "kept local"],
      }),
    );
    expect(safe.ok).toBe(true);
    expect(safe.score).toBe(100);

    const wrapped = scoreGlm52AgentProof(
      JSON.stringify({
        result: {
          payloads: [
            {
              text: JSON.stringify({
                role: "snes-hardware-qa",
                changedSurface: "settings/export/hardwareQa",
                content: "ROM SRAM VRAM CGRAM ARAM FXPAK SuperFX checksum FAT32 ready",
                constraintsRespected: ["SNES safe", "local GLM"],
                playtestHypothesis: "Boot and save are checked in the first 30 seconds.",
                riskBlocker: "none",
                patch: [{ op: "replace", path: "/settings/export/hardwareQa", value: "ready" }],
                receipt: ["checked hardware", "kept local"],
              }),
            },
          ],
        },
      }),
    );
    expect(wrapped.ok).toBe(true);
    expect(wrapped.score).toBe(100);
  });

  it("runs GLM agent proof through the promoted agent default instead of an unauthorized model override", () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnSyncFn = (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            meta: {
              agentMeta: {
                model: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
                provider: "local-glm52",
              },
            },
            payloads: [
              {
                text: JSON.stringify({
                  role: "snes-hardware-qa",
                  changedSurface: "settings/export/hardwareQa",
                  content: "ROM SRAM VRAM CGRAM ARAM FXPAK SuperFX checksum FAT32 ready",
                  constraintsRespected: ["SNES safe", "local GLM"],
                  playtestHypothesis: "Boot and save are checked in the first 30 seconds.",
                  riskBlocker: "none",
                  patch: [{ op: "replace", path: "/settings/export/hardwareQa", value: "ready" }],
                  receipt: ["checked hardware", "kept local"],
                }),
              },
            ],
          },
        }),
      };
    };

    const report = runGlm52AgentProof(
      {
        agent: "snes-hardware-qa",
        modelId: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
        proofArtifactDir: ".artifacts/test-glm52-agent-proof",
        proofSessionId: "test-glm52-proof",
        providerId: "local-glm52",
        timeoutSeconds: 600,
      },
      { spawnSyncFn },
    );

    expect(report.ok).toBe(true);
    expect(calls[0]?.args).not.toContain("--model");
    expect(calls[0]?.args).toContain("--session-id");
    expect(calls[0]?.args).toContain("test-glm52-proof");
  });

  it("fails GLM agent proof when OpenClaw falls back to a non-GLM model", () => {
    const report = runGlm52AgentProof(
      {
        agent: "snes-hardware-qa",
        modelId: "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
        proofArtifactDir: ".artifacts/test-glm52-agent-proof",
        proofSessionId: "test-glm52-proof",
        providerId: "local-glm52",
        timeoutSeconds: 600,
      },
      {
        spawnSyncFn: () => ({
          status: 0,
          stdout: JSON.stringify({
            meta: {
              agentMeta: {
                model: "openclaw-control-qwen25-32b:latest",
                provider: "ollama",
              },
            },
            payloads: [
              {
                text: JSON.stringify({
                  role: "snes-hardware-qa",
                  changedSurface: "settings/export/hardwareQa",
                  content: "ROM SRAM VRAM CGRAM ARAM FXPAK SuperFX checksum FAT32 ready",
                  constraintsRespected: ["SNES safe", "local GLM"],
                  playtestHypothesis: "Boot and save are checked in the first 30 seconds.",
                  riskBlocker: "none",
                  patch: [{ op: "replace", path: "/settings/export/hardwareQa", value: "ready" }],
                  receipt: ["checked hardware", "kept local"],
                }),
              },
            ],
          }),
        }),
      },
    );

    expect(report.proof.ok).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.blocker).toContain("did not use local GLM-5.2");
  });

  it("scores real output benchmark responses with fail-closed caps", () => {
    const task = SNES_BENCHMARK_TASKS.find((candidate) => candidate.role === "snes-level-designer");
    expect(task).toBeTruthy();

    const invalid = scoreSnesOutputBenchmarkResponse({ raw: "not json", task });
    expect(invalid.status).toBe("fail");
    expect(invalid.caps).toContain("invalid-json-cap-49");

    const unsafe = scoreSnesOutputBenchmarkResponse({
      latencyMs: 1000,
      raw: JSON.stringify({
        role: "snes-level-designer",
        taskId: task.id,
        changedSurface: "level",
        content: "level reachable jump reward goal fair",
        constraintsRespected: ["SNES safe", "beginner fair"],
        playtestHypothesis: "The first 30 seconds tests a reachable jump and reward path.",
        riskBlocker: "none",
        patch: [{ op: "replace", path: "/packageJson/scripts/postinstall", value: "bad" }],
        receipt: ["changed level", "kept constraints"],
      }),
      task,
    });
    expect(unsafe.score).toBeLessThanOrEqual(39);
    expect(unsafe.caps).toContain("unsafe-or-missing-patch-cap-39");

    const safe = scoreSnesOutputBenchmarkResponse({
      judgeScore: 9,
      latencyMs: 1000,
      raw: JSON.stringify({
        role: "snes-level-designer",
        taskId: task.id,
        changedSurface: "scenes/0/terrain",
        content: "SNES level has reachable jump, visible reward, fair enemy, and clear goal path.",
        constraintsRespected: ["SNES tile budget", "beginner-safe first jump"],
        playtestHypothesis:
          "The first 30 seconds lets the player move, jump, collect a reward, and see the goal path.",
        riskBlocker: "none",
        patch: [{ op: "replace", path: "/scenes/0/terrain/0", value: { width: 48 } }],
        receipt: ["made first jump reachable", "moved reward onto main route"],
      }),
      task,
    });
    expect(safe.score).toBeGreaterThanOrEqual(80);
    expect(safe.status).toMatch(/pass|warning/);
  });

  it("runs output benchmark with local model outputs, GPT judge gate, and no hosted GLM", () => {
    const originalJudge = process.env.OPENCLAW_SNES_BENCHMARK_GPT_JUDGE;
    process.env.OPENCLAW_SNES_BENCHMARK_GPT_JUDGE = "1";
    const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn = (command: string, args: readonly string[]) => {
      spawnCalls.push({ command, args });
      if (command === "ollama") {
        return {
          status: 0,
          stdout: JSON.stringify({
            role: "snes-game-director",
            taskId: "task",
            changedSurface: "gamePlan",
            content:
              "SNES JSON patch receipt constraint level reachable jump reward goal enemy fair tile sprite palette music sound ROM SRAM VRAM CGRAM FXPAK",
            constraintsRespected: ["SNES safe", "hardware safe"],
            playtestHypothesis:
              "The opening tests movement, reward, challenge, and goal visibility.",
            riskBlocker: "none",
            patch: [{ op: "replace", path: "/gamePlan/premise", value: "Moon courier" }],
            receipt: ["changed premise", "kept export safe"],
          }),
        };
      }
      if (command === "curl") {
        return {
          status: 0,
          stdout: JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    role: "snes-level-designer",
                    taskId: "task",
                    changedSurface: "scenes",
                    content:
                      "SNES JSON patch receipt constraint level reachable jump reward goal enemy fair tile sprite palette music sound ROM SRAM VRAM CGRAM FXPAK",
                    constraintsRespected: ["local GLM only", "SNES safe"],
                    playtestHypothesis:
                      "The player can reach the first reward and see the goal path.",
                    riskBlocker: "none",
                    patch: [{ op: "replace", path: "/scenes/0/entities/0", value: { x: 20 } }],
                    receipt: ["changed scene", "kept safe"],
                  }),
                },
              },
            ],
          }),
        };
      }
      if (command === "pnpm") {
        return {
          status: 0,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              score: 8,
              strengths: ["clear"],
              weaknesses: [],
              winnerRationale: "usable",
            }),
          }),
        };
      }
      return { status: 1, stderr: "unexpected" };
    };

    const report = createSnesOutputBenchmarkReport({
      defaultModelsByRole: {
        "snes-art-audio": "ollama/openclaw-control-qwen25-32b:latest",
        "snes-game-director": "ollama/openclaw-control-qwen25-32b:latest",
        "snes-gameplay-designer": "ollama/openclaw-control-qwen25-32b:latest",
        "snes-hardware-qa": "ollama/openclaw-control-qwen25-32b:latest",
        "snes-level-designer": "ollama/openclaw-control-qwen25-32b:latest",
      },
      generatedAt: "2026-06-22T00:00:00.000Z",
      installedModelRefs: ["ollama/openclaw-control-qwen25-32b:latest", "local-glm-5.2-2bit"],
      judge: "gpt-5.5",
      spawn,
      timeoutSeconds: 30,
    });

    expect(report.format).toBe("openclaw-snes-real-output-model-benchmark-report");
    expect(report.downloadsAttempted).toBe(false);
    expect(report.hostedGlmUsed).toBe(false);
    expect(report.hostedProvidersUsed).toBe(true);
    expect(
      report.results.some((result) => result.modelRef === "local-glm-5.2-2bit" && result.available),
    ).toBe(true);
    expect(
      spawnCalls.some((call) => call.command === "pnpm" && call.args.includes("openai/gpt-5.5")),
    ).toBe(true);
    expect(
      spawnCalls.some((call) => call.command === "curl" && call.args.join(" ").includes("hosted")),
    ).toBe(false);
    if (originalJudge === undefined) {
      delete process.env.OPENCLAW_SNES_BENCHMARK_GPT_JUDGE;
    } else {
      process.env.OPENCLAW_SNES_BENCHMARK_GPT_JUDGE = originalJudge;
    }
  });

  it("aggregates repeated output benchmark rounds and writes a side-by-side summary", () => {
    const defaultModel = "ollama/openclaw-control-qwen25-32b:latest";
    const localGlm = "local-glm-5.2-2bit";
    const spawn = (_command: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("/api/generate")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            response: JSON.stringify({
              role: "snes-hardware-qa",
              taskId: "snes-hardware-qa-correctness",
              changedSurface: "hardware QA",
              content: "ROM and SRAM fixed; graphics and flash cart review still missing.",
              constraintsRespected: ["ROM safe", "SRAM safe"],
              playtestHypothesis: "The first 30 seconds checks startup and save.",
              riskBlocker: "VRAM and CGRAM still need review",
              patch: [{ op: "replace", path: "/settings/export", value: "safe" }],
              receipt: ["checked ROM", "checked SRAM"],
            }),
          }),
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  role: "snes-hardware-qa",
                  taskId: "snes-hardware-qa-correctness",
                  changedSurface: "hardware QA",
                  content:
                    "ROM SRAM VRAM CGRAM FXPAK blockers reviewed with checksum and FAT32 repairs.",
                  constraintsRespected: ["SNES safe", "FXPAK FAT32 safe"],
                  playtestHypothesis:
                    "The first 30 seconds verifies boot, visible graphics, audio, and save.",
                  riskBlocker: "none",
                  patch: [{ op: "replace", path: "/settings/export", value: "fxpak-safe" }],
                  receipt: ["checked ROM/SRAM/VRAM/CGRAM", "checked FXPAK"],
                }),
              },
            },
          ],
        }),
      };
    };

    const report = createSnesOutputBenchmarkReport({
      candidateModelRefs: [defaultModel, localGlm],
      defaultModelsByRole: { "snes-hardware-qa": defaultModel },
      generatedAt: "2026-06-22T01:02:03.000Z",
      installedModelRefs: [defaultModel, localGlm],
      roles: ["snes-hardware-qa"],
      rounds: 3,
      spawn,
      timeoutSeconds: 30,
    });

    expect(report.rounds).toBe(3);
    expect(report.results).toHaveLength(6);
    expect(report.recommendedWinnersByRole["snes-hardware-qa"]).toBe(localGlm);
    expect(report.promotionRecommendationsByRole["snes-hardware-qa"]).toMatchObject({
      currentDefault: defaultModel,
      readyToPromote: true,
      recommendedModel: localGlm,
    });
    const glmSummary = report.modelSummaries.find(
      (summary) => summary.role === "snes-hardware-qa" && summary.modelRef === localGlm,
    );
    expect(glmSummary).toMatchObject({
      availableRuns: 3,
      blockedRuns: 0,
      failedRuns: 0,
      invalidJsonRuns: 0,
      rounds: 3,
    });

    const markdown = renderBenchmarkSummaryMarkdown(report);
    expect(markdown).toContain("SNES Real Output Model Benchmark");
    expect(markdown).toContain("local-glm-5.2-2bit");
    expect(markdown).toContain("Rounds: 3");

    const dir = mkdtempSync(join(tmpdir(), "openclaw-snes-benchmark-"));
    try {
      const artifacts = writeBenchmarkArtifacts(report, dir);
      expect(artifacts.summaryPath).toBe(join(dir, "latest-summary.md"));
      expect(readFileSync(artifacts.summaryPath!, "utf8")).toContain("local-glm-5.2-2bit");
      expect(readFileSync(join(dir, "2026-06-22T01-02-03-000Z", "report.json"), "utf8")).toContain(
        '"rounds": 3',
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps CI and release dashboard artifact chains wired to hardware proof bundles", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["ui:smoke:dashboard"]).toBe(
      "node --import tsx scripts/dev/control-ui-dashboard-smoke-suite.ts",
    );

    const workflows = [
      {
        path: ".github/workflows/ci.yml",
        jobName: "dashboard-smoke",
        suiteCommand: "pnpm ui:smoke:dashboard -- --artifact-profile ci",
        artifactName: "control-ui-snes-studio-hardware-proof-",
        requiredNeeds: ["preflight", "build-artifacts"],
        expectedRunner: "ubuntu-24.04",
        buildStep: null,
        downloadArtifact: true,
      },
      {
        path: ".github/workflows/openclaw-release-checks.yml",
        jobName: "dashboard_smoke_release_checks",
        suiteCommand: "pnpm ui:smoke:dashboard -- --artifact-profile release",
        artifactName: "release-control-ui-snes-studio-hardware-proof-",
        requiredNeeds: ["resolve_target"],
        expectedRunner: "blacksmith-8vcpu-ubuntu-2404",
        buildStep: ["pnpm ui:build", "pnpm build"],
        downloadArtifact: false,
      },
    ];

    for (const workflow of workflows) {
      const document = parse(readFileSync(workflow.path, "utf8")) as {
        jobs?: Record<
          string,
          {
            needs?: string[];
            "runs-on"?: string;
            steps?: Array<Record<string, unknown>>;
          }
        >;
      };
      const job = document.jobs?.[workflow.jobName];
      expect(job).toBeTruthy();
      expect(job?.needs).toEqual(workflow.requiredNeeds);
      expect(job?.["runs-on"]).toBe(workflow.expectedRunner);
      const steps = job?.steps ?? [];

      if (workflow.downloadArtifact) {
        expect(steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "Download built runtime artifacts",
              uses: "actions/download-artifact@v8",
              with: expect.objectContaining({
                name: "dist-runtime-build",
                path: ".",
              }),
            }),
            expect.objectContaining({
              name: "Extract built runtime artifacts",
            }),
          ]),
        );
      }
      if (workflow.buildStep) {
        expect(steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "Build dashboard runtime",
              run: expect.stringContaining(workflow.buildStep[0]),
            }),
          ]),
        );
        expect(steps.find((step) => step.name === "Build dashboard runtime")?.run).toEqual(
          expect.stringContaining(workflow.buildStep[1]),
        );
      }

      expect(steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Install Playwright Chromium",
            run: "pnpm exec playwright install --with-deps chromium",
          }),
          expect.objectContaining({
            name: "Run dashboard smoke suite",
            run: workflow.suiteCommand,
          }),
        ]),
      );
      expect(steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Upload SNES Studio hardware proof artifacts",
            with: expect.objectContaining({
              name: expect.stringContaining(workflow.artifactName),
              path: ".artifacts/snes-hardware-proof/",
            }),
          }),
        ]),
      );
    }
  });

  it("keeps Full Release Validation dashboard reruns routed into release checks", () => {
    const document = parse(
      readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
    ) as {
      on?: {
        workflow_dispatch?: {
          inputs?: {
            rerun_group?: {
              options?: string[];
            };
          };
        };
      };
      jobs?: Record<
        string,
        {
          if?: string;
          needs?: string[];
        }
      >;
    };

    expect(document.on?.workflow_dispatch?.inputs?.rerun_group?.options).toContain("dashboard");
    expect(document.jobs?.release_checks?.needs).toEqual([
      "resolve_target",
      "docker_runtime_assets_preflight",
    ]);
    expect(document.jobs?.release_checks?.if).toContain('"dashboard"');
    expect(document.jobs?.release_checks?.if).toContain("inputs.rerun_group");
  });
});
