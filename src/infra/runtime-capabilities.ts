import {
  getEmbeddedStandaloneRuntimeRoot,
  getStandaloneRuntimeBuild,
  type StandaloneBuildInfo,
} from "../../cli-invocation.mjs";
import { parseNodeOptionsEnvVar } from "../../node-runtime-env.mjs";
import type { DiagnosticProfileOutcome } from "../logging/diagnostic-profile.js";
import { getRuntimeExecutionProfile } from "./runtime-profile.js";

type Capability = {
  state: "available" | "unavailable" | "unknown";
  reason: string;
};

type ProfileCapability = "cpuProfiling" | "heapSampling" | "heapSnapshot";
const profileObservations = new Map<ProfileCapability, Capability>();

/** Captures stay with their existing owners; diagnostics only remembers observed support. */
export async function observeRuntimeProfileCapability<Result>(
  capability: ProfileCapability,
  capture: Promise<DiagnosticProfileOutcome<Result>>,
): Promise<DiagnosticProfileOutcome<Result>> {
  const outcome = await capture;
  profileObservations.set(
    capability,
    outcome.status === "complete"
      ? { state: "available", reason: "The latest explicit capture completed in this process." }
      : {
          state:
            outcome.reason === "unsupported"
              ? "unavailable"
              : (profileObservations.get(capability)?.state ?? "unknown"),
          reason: `The latest explicit capture returned ${outcome.reason}.`,
        },
  );
  return outcome;
}

function profileCapability(name: ProfileCapability, reason: string): Capability {
  return profileObservations.get(name) ?? { state: "unknown", reason };
}

/** Read-only facts for this process; never execute generated code or load optional addons. */
export function collectRuntimeCapabilities() {
  let build: StandaloneBuildInfo | undefined;
  let buildError: string | undefined;
  try {
    build = getStandaloneRuntimeBuild();
  } catch (error) {
    buildError = error instanceof Error ? error.message : String(error);
  }
  const kind = process.versions.bun ? "bun" : process.versions.node ? "node" : "unknown";
  const flavor =
    build?.mode === "aot"
      ? "aot"
      : build?.mode
        ? "jit"
        : getEmbeddedStandaloneRuntimeRoot() || buildError || kind === "unknown"
          ? "unknown"
          : "jit";
  const environmentOptions = parseNodeOptionsEnvVar(
    kind === "bun" ? process.env.BUN_OPTIONS : process.env.NODE_OPTIONS,
  );
  const flags = [...(environmentOptions ?? []), ...process.execArgv];
  let stringCodegenDisabled = false;
  for (const flag of flags) {
    if (/^--disallow[-_]code[-_]generation[-_]from[-_]strings(?:=(?:true|strict))?$/.test(flag)) {
      stringCodegenDisabled = true;
    }
    if (
      /^--(?:no[-_]disallow[-_]code[-_]generation[-_]from[-_]strings|disallow[-_]code[-_]generation[-_]from[-_]strings=false)$/.test(
        flag,
      )
    ) {
      stringCodegenDisabled = false;
    }
  }
  const codeGenerationFromStrings: Capability = stringCodegenDisabled
    ? {
        state: "unavailable",
        reason:
          "Disabled by runtime flags; build-time constant expressions may already be compiled.",
      }
    : flavor === "aot" || flavor === "unknown" || environmentOptions === null
      ? {
          state: "unknown",
          reason:
            "AOT reachability and embedding policy are not introspectable without changing the compiled graph; no eval probe was run.",
        }
      : { state: "available", reason: "Ordinary runtime default; no disabling flag was observed." };
  const executableMemory: Capability & { declaredPolicy: string; scope: "this-process" } = {
    state: "unknown",
    declaredPolicy:
      flavor === "aot"
        ? process.platform === "linux"
          ? "Bun AOT requests MDWE on supported Linux kernels. Compiler hardening may additionally restrict children."
          : process.platform === "darwin"
            ? "AOT signing requires hardened runtime without allow-jit. Actual signature and sandbox policy are not inspected."
            : "AOT does not need JIT executable memory."
        : "JIT may require executable memory; host signing and sandbox policy still apply.",
    scope: "this-process",
    reason:
      "No generated-native-code probe was run; such a probe can terminate a hardened process. External children have their own policy; self-reexec workers use this image again.",
  };
  const interpreter: Capability =
    flavor === "aot"
      ? {
          state: "unknown",
          reason:
            "Interpreter execution depends on compiler reachability and trimming, separately from executable-memory permission. The interpreter tripwire is not a capability test.",
        }
      : flavor === "unknown"
        ? { state: "unknown", reason: "The executing image does not expose its compilation mode." }
        : {
            state: "available",
            reason:
              "Ordinary Node/Bun runtime includes an interpreter; embedding or sandbox restrictions may limit dynamic execution.",
          };
  const debuggerCapability: Capability =
    flavor === "aot"
      ? {
          state: "unavailable",
          reason:
            "Default AOT artifacts do not support breakpoints. Use the matched JIT support artifact.",
        }
      : {
          state: "unknown",
          reason: build?.build?.debugEntry
            ? `Use the retained source debugger at ${build.build.debugEntry} with its matching Bun executable. No debugger port was opened by diagnostics.`
            : "Use the runtime inspector to attach; no debugger port was opened by diagnostics.",
        };
  const executionProfile = buildError ? "unknown" : getRuntimeExecutionProfile();
  return {
    schemaVersion: 1,
    process: {
      kind,
      version: process.versions.bun ?? process.versions.node ?? null,
      platform: process.platform,
      arch: process.arch,
      flavor,
    },
    build: build ?? null,
    execution: {
      profile: executionProfile,
      dynamicCode: executionProfile === "embedded-aot" ? "interpreted" : "runtime-default",
    },
    ...(buildError ? { buildError } : {}),
    capabilities: {
      executableMemory,
      codeGenerationFromStrings,
      interpreter,
      debugger: debuggerCapability,
      cpuProfiling: profileCapability(
        "cpuProfiling",
        "Local CPU profiling is independent of debugger breakpoints. Not yet requested in this process; use diagnostics.cpuProfile.",
      ),
      heapSampling: profileCapability(
        "heapSampling",
        "Requires HeapProfiler sampling methods. Not yet requested in this process; use diagnostics.heapProfile.",
      ),
      heapSnapshot: profileCapability(
        "heapSnapshot",
        "Native snapshots and allocation sampling are separate capabilities. Not yet requested in this process; use diagnostics.heapSnapshot explicitly.",
      ),
    },
    nativeCompatibility: {
      inventory: build?.nativeModules ? "packaged" : "not-recorded",
      target: {
        ...(build?.target ?? { platform: process.platform, arch: process.arch }),
        ...(process.platform === "linux" ? { libc: "unknown" } : {}),
      },
      modules: build?.nativeModules ?? [],
      qualification: "unverified",
      reason:
        "Packaged native binaries are a target inventory, not workload qualification. Verify the selected backend, libc, signature and native operations on this exact artifact. Installed plugins and external child runtimes require their own evidence.",
    },
  };
}

export function formatRuntimeCapabilities(report: ReturnType<typeof collectRuntimeCapabilities>) {
  const lines = [
    `Runtime: ${report.process.kind} ${report.process.version ?? "unknown"}; flavor=${report.process.flavor}; ${report.process.platform}/${report.process.arch}`,
  ];
  if (report.build) {
    lines.push(
      `OpenClaw: ${report.build.openclaw.version}; commit=${report.build.openclaw.commit ?? "unknown"}`,
    );
    if (report.build.build) {
      const build = report.build.build;
      lines.push(
        `Build: ${build.id}; ${build.flavor}; plugin set=${build.pluginSetSha256}; module graph=${build.moduleGraphSha256}`,
      );
    }
    if (report.build.plugins) {
      lines.push(`Embedded plugins: ${report.build.plugins.embedded.join(", ")}`);
    }
  }
  lines.push(
    `Execution profile: ${report.execution.profile}; dynamic code=${report.execution.dynamicCode}`,
  );
  if (report.execution.dynamicCode === "interpreted") {
    lines.push(
      "Fetched plugins, Node Code Mode, and QA expressions run interpreted in this AOT build; use a JIT build for full speed. Runtime flags and module availability still apply.",
    );
  }
  for (const [name, capability] of Object.entries(report.capabilities)) {
    lines.push(`${name}: ${capability.state}. ${capability.reason}`);
  }
  lines.push(`Executable-memory policy: ${report.capabilities.executableMemory.declaredPolicy}`);
  for (const module of report.nativeCompatibility.modules) {
    lines.push(
      `Native ${module.name}@${module.version}: ${module.qualification}; backend=${module.backend}`,
    );
  }
  lines.push(report.nativeCompatibility.reason);
  return lines.join("\n");
}
