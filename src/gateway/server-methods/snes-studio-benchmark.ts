import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applySnesGenericProductionPatch,
  createDefaultSnesStudioProject,
  createSnesAssetAdapterPlan,
  createSnesEmulatorProofPlanFromToolchain,
  createSnesFxpakDryRunPlan,
  createSnesGenericProductionPacket,
  createSnesGenericProductionState,
  createSnesMvpSampleProjectPackage,
  createSnesProductionReadinessReport,
  createSnesProjectPackage,
  createSnesRomBuildScaffoldDryRun,
  createStanskiCanaryProjectPackage,
  createSnesToolchainDoctorReport,
  parseSnesProjectPackage,
  type SnesGenericProductionState,
  type SnesProjectPackage,
  type SnesToolchainDoctorInput,
  type SnesToolchainDoctorReport,
  type SnesToolchainToolId,
} from "../../../packages/snes-studio-core/src/index.ts";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type JsonRecord = Record<string, unknown>;

const GLM52_LOCAL_PROVIDER_ID = "local-glm52";
const GLM52_LOCAL_BENCHMARK_MODEL_REF = "local-glm-5.2-2bit";
const GLM52_DEFAULT_MODEL_ID = "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf";
const GLM52_HARDWARE_QA_AGENT_ID = "snes-hardware-qa";

export type SnesBenchmarkLatestSnapshot = {
  available: boolean;
  blocker: string | null;
  generatedAt: string | null;
  status: string;
  reportPath: string;
  summaryPath: string;
  summaryMarkdown: string | null;
  currentDefaultsByRole: JsonRecord;
  recommendedWinnersByRole: JsonRecord;
  winnersByRole: JsonRecord;
  modelSummaries: unknown[];
  rounds: number | null;
  hostedProvidersUsed: boolean;
  hostedGlmUsed: boolean;
  downloadsAttempted: boolean;
  promotionApplied: boolean;
};

export type SnesGlm52StatusSnapshot = {
  available: boolean;
  blocker: string | null;
  providerId: string;
  modelRef: string;
  runtimeReady: boolean;
  runtimeStatus: string;
  providerConfigured: boolean;
  hardwareQaPromoted: boolean;
  hardwareQaModel: unknown;
  benchmarkRecommendsHardwareQa: boolean;
  agentProofReady: boolean;
  agentProofScore: number | null;
  runtimeReportPath: string;
  agentProofReportPath: string;
  generatedAt: string | null;
};

export type StanskiProductionStatusSnapshot = {
  status: string;
  ok?: boolean;
  ready?: boolean;
  blocker?: string | null;
  completedCount?: number;
  totalCount?: number;
  currentMilestone?: unknown;
  nextMilestone?: unknown;
  state?: JsonRecord;
  paths?: JsonRecord;
  results?: unknown[];
  gpt55UsagePolicy?: JsonRecord;
  policySummary?: JsonRecord;
  productionPolicy?: JsonRecord;
  control?: JsonRecord;
  lock?: JsonRecord | null;
};

export type SnesGenericProductionSnapshot = {
  status: "ready" | "blocked" | "paused" | "complete" | "pass";
  projectId: string;
  projectName: string;
  completedCount: number;
  totalCount: number;
  currentMilestone: unknown;
  nextMilestone: unknown;
  blocker: string | null;
  paths: JsonRecord;
  state: SnesGenericProductionState;
  projectPackage: SnesProjectPackage;
  packet: unknown;
  toolchain: SnesToolchainDoctorReport;
  adapterPlan: unknown;
  romScaffold: unknown;
  emulatorPlan: unknown;
  fxpakPlan: unknown;
  projectProof: JsonRecord;
  control: JsonRecord;
  latestReceipt: unknown;
  gpt55Used: false;
  localGlmOnly: true;
  workerMode: "deterministic-contract-proof";
};

export type SnesToolchainStatusSnapshot = SnesToolchainDoctorReport & {
  generatedAt: string;
  liveProbe: true;
  manifestPath: string;
  receiptSummary: JsonRecord;
  toolchainHome: string;
};

export type SnesGenericProofActionId =
  | "browser-smoke"
  | "budget-enforcement"
  | "emulator-headless"
  | "fxpak-package-dry-run"
  | "generic-project-gate"
  | "mastery-refresh"
  | "runtime-asset-truth";

export type SnesBlankProjectReceipt = {
  generatedAt: string;
  hostedGlmUsed: false;
  localOnly: true;
  packageHash: string;
  packagePath: string;
  projectId: string;
  projectName: string;
  projectSpecific: false;
  proofClaim: "project-package-created-only";
  removableMediaWritePerformed: false;
  status: "pass";
};

export type SnesGenericProofActionReceipt = {
  actionId: SnesGenericProofActionId;
  blocker: string | null;
  blockers: string[];
  command: string;
  generatedAt: string;
  hostedGlmUsed: false;
  localOnly: true;
  projectSpecific: false;
  removableMediaWritePerformed: false;
  status: string;
  summary: JsonRecord;
};

export type SnesMasteryStatusSnapshot = {
  available: boolean;
  blocker: string | null;
  generatedAt: string | null;
  status: string;
  statusPath: string;
  roadmapPath: string;
  ledgerPath: string;
  kataSummary: JsonRecord;
  milestoneSummary: JsonRecord;
  nextIncomplete: unknown;
  nextKata: unknown;
  blockers: unknown[];
  legalCorpus: {
    ok: boolean | null;
    status: string;
    path: string;
  };
  genericScope: {
    status: string;
    path: string;
  };
  gpt55Used: false;
  hostedGlmUsed: false;
  projectSpecific: false;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function primaryModelRef(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (isRecord(value) && typeof value.primary === "string" && value.primary.trim()) {
    return value.primary.trim();
  }
  return null;
}

function repoPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : filePath.split(path.sep).join("/");
}

export async function loadSnesBenchmarkLatestSnapshot(opts?: {
  artifactDir?: string;
}): Promise<SnesBenchmarkLatestSnapshot> {
  const artifactDir =
    opts?.artifactDir ??
    process.env.OPENCLAW_SNES_BENCHMARK_ARTIFACT_DIR ??
    path.join(process.cwd(), ".artifacts", "snes-real-output-model-benchmark");
  const reportPath = path.join(artifactDir, "latest.json");
  const summaryPath = path.join(artifactDir, "latest-summary.md");
  let reportRaw: string;
  try {
    reportRaw = await readFile(reportPath, "utf8");
  } catch {
    return {
      available: false,
      blocker:
        "No real output benchmark report found. Run pnpm snes:benchmark:models -- --mode output --no-download --json.",
      currentDefaultsByRole: {},
      downloadsAttempted: false,
      generatedAt: null,
      hostedGlmUsed: false,
      hostedProvidersUsed: false,
      modelSummaries: [],
      promotionApplied: false,
      recommendedWinnersByRole: {},
      reportPath: repoPath(reportPath),
      rounds: null,
      status: "missing",
      summaryMarkdown: null,
      summaryPath: repoPath(summaryPath),
      winnersByRole: {},
    };
  }
  const parsed = JSON.parse(reportRaw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("latest benchmark report is not a JSON object");
  }
  let summaryMarkdown: string | null = null;
  try {
    summaryMarkdown = await readFile(summaryPath, "utf8");
  } catch {
    summaryMarkdown = null;
  }
  return {
    available: true,
    blocker: null,
    currentDefaultsByRole: asRecord(parsed.currentDefaultsByRole),
    downloadsAttempted: parsed.downloadsAttempted === true,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
    hostedGlmUsed: parsed.hostedGlmUsed === true,
    hostedProvidersUsed: parsed.hostedProvidersUsed === true,
    modelSummaries: asArray(parsed.modelSummaries),
    promotionApplied: parsed.promotionApplied === true,
    recommendedWinnersByRole: asRecord(parsed.recommendedWinnersByRole ?? parsed.winnersByRole),
    reportPath: repoPath(reportPath),
    rounds: typeof parsed.rounds === "number" ? parsed.rounds : null,
    status: typeof parsed.status === "string" ? parsed.status : "unknown",
    summaryMarkdown,
    summaryPath: repoPath(summaryPath),
    winnersByRole: asRecord(parsed.winnersByRole),
  };
}

async function readJsonFile(filePath: string): Promise<JsonRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadSnesMasteryStatusSnapshot(opts?: {
  artifactRoot?: string;
}): Promise<SnesMasteryStatusSnapshot> {
  const artifactRoot =
    opts?.artifactRoot ??
    process.env.OPENCLAW_SNES_MASTERY_ARTIFACT_ROOT ??
    path.join(process.cwd(), ".artifacts", "snes-game-builder-reference");
  const statusPath = path.join(artifactRoot, "manifests", "snes-mastery-status-receipt.json");
  const roadmapPath = path.join(artifactRoot, "mastery", "snes-mastery-roadmap-v1.json");
  const ledgerPath = path.join(artifactRoot, "mastery", "snes-mastery-ledger.json");
  const legalPath = path.join(artifactRoot, "manifests", "validation-receipt.json");
  const scopePath = path.join(artifactRoot, "manifests", "generic-scope-guard-receipt.json");
  const status = await readJsonFile(statusPath);
  const legal = await readJsonFile(legalPath);
  const scope = await readJsonFile(scopePath);
  if (!status) {
    return {
      available: false,
      blocker: "No SNES Mastery status receipt found. Run pnpm snes:mastery refresh --json.",
      blockers: [
        {
          id: "snes-mastery-status",
          blockers: ["status receipt missing"],
          percentComplete: 0,
          title: "SNES Mastery status",
        },
      ],
      generatedAt: null,
      genericScope: {
        path: repoPath(scopePath),
        status: typeof scope?.status === "string" ? scope.status : "missing",
      },
      gpt55Used: false,
      hostedGlmUsed: false,
      kataSummary: {},
      ledgerPath: repoPath(ledgerPath),
      legalCorpus: {
        ok: typeof legal?.ok === "boolean" ? legal.ok : null,
        path: repoPath(legalPath),
        status: legal?.ok === true ? "pass" : "missing",
      },
      milestoneSummary: {},
      nextIncomplete: null,
      nextKata: null,
      projectSpecific: false,
      roadmapPath: repoPath(roadmapPath),
      status: "missing",
      statusPath: repoPath(statusPath),
    };
  }
  return {
    available: true,
    blocker:
      typeof status.status === "string" && status.status === "blocked"
        ? "One or more SNES Mastery milestones are blocked."
        : null,
    blockers: asArray(status.blockers),
    generatedAt: typeof status.generatedAt === "string" ? status.generatedAt : null,
    genericScope: {
      path: repoPath(scopePath),
      status: typeof scope?.status === "string" ? scope.status : "missing",
    },
    gpt55Used: false,
    hostedGlmUsed: false,
    kataSummary: asRecord(status.kataSummary),
    ledgerPath: repoPath(ledgerPath),
    legalCorpus: {
      ok: typeof legal?.ok === "boolean" ? legal.ok : null,
      path: repoPath(legalPath),
      status: legal?.ok === true ? "pass" : "blocked",
    },
    milestoneSummary: asRecord(status.milestoneSummary),
    nextIncomplete: status.nextIncomplete ?? null,
    nextKata: status.nextKata ?? null,
    projectSpecific: false,
    roadmapPath: repoPath(roadmapPath),
    status: typeof status.status === "string" ? status.status : "unknown",
    statusPath: repoPath(statusPath),
  };
}

export async function loadSnesGlm52StatusSnapshot(opts?: {
  agentProofArtifactDir?: string;
  benchmarkArtifactDir?: string;
  config?: JsonRecord;
  providerId?: string;
  runtimeArtifactDir?: string;
}): Promise<SnesGlm52StatusSnapshot> {
  const providerId = opts?.providerId ?? GLM52_LOCAL_PROVIDER_ID;
  const runtimeArtifactDir =
    opts?.runtimeArtifactDir ??
    process.env.OPENCLAW_GLM52_RUNTIME_ARTIFACT_DIR ??
    path.join(process.cwd(), ".artifacts", "glm52-local-runtime");
  const agentProofArtifactDir =
    opts?.agentProofArtifactDir ??
    process.env.OPENCLAW_GLM52_AGENT_PROOF_ARTIFACT_DIR ??
    path.join(process.cwd(), ".artifacts", "glm52-agent-proof");
  const runtimeReportPath = path.join(runtimeArtifactDir, "latest.json");
  const agentProofReportPath = path.join(agentProofArtifactDir, "latest.json");
  const runtimeReport = await readJsonFile(runtimeReportPath);
  const agentProofReport = await readJsonFile(agentProofReportPath);
  const benchmark = await loadSnesBenchmarkLatestSnapshot({
    artifactDir: opts?.benchmarkArtifactDir,
  });

  const diagnostic = asRecord(runtimeReport?.diagnostic);
  const modelId =
    typeof diagnostic.modelId === "string" && diagnostic.modelId.trim()
      ? diagnostic.modelId.trim()
      : GLM52_DEFAULT_MODEL_ID;
  const modelRef = `${providerId}/${modelId}`;
  const config = opts?.config ?? {};
  const providers = asRecord(asRecord(config.models).providers);
  const providerConfigured = Boolean(providers[providerId]);
  const agents = asArray(asRecord(config.agents).list);
  const hardwareQaAgent = agents.find(
    (entry) => isRecord(entry) && entry.id === GLM52_HARDWARE_QA_AGENT_ID,
  );
  const hardwareQaModel = isRecord(hardwareQaAgent) ? hardwareQaAgent.model : null;
  const hardwareQaPrimary = primaryModelRef(hardwareQaModel);
  const hardwareQaPromoted = hardwareQaPrimary === modelRef;
  const benchmarkRecommendsHardwareQa =
    benchmark.recommendedWinnersByRole[GLM52_HARDWARE_QA_AGENT_ID] ===
      GLM52_LOCAL_BENCHMARK_MODEL_REF ||
    benchmark.winnersByRole[GLM52_HARDWARE_QA_AGENT_ID] === GLM52_LOCAL_BENCHMARK_MODEL_REF;
  const proof = asRecord(agentProofReport?.proof);
  const proofScore = typeof proof.score === "number" ? proof.score : null;
  const agentProofReady = agentProofReport?.ok === true && (proofScore ?? 0) >= 100;
  const runtimeReady = diagnostic.decodeReady === true;
  const blockers = [
    runtimeReady ? null : "local llama.cpp GLM-5.2 decode probe is not ready",
    providerConfigured ? null : "local-glm52 provider is not registered in OpenClaw config",
    benchmarkRecommendsHardwareQa
      ? null
      : "latest benchmark does not recommend GLM for hardware QA",
    hardwareQaPromoted ? null : "snes-hardware-qa is not promoted to local GLM-5.2",
    agentProofReady ? null : "latest GLM agent proof has not passed",
  ].filter((entry): entry is string => Boolean(entry));

  return {
    agentProofReady,
    agentProofReportPath: repoPath(agentProofReportPath),
    agentProofScore: proofScore,
    available: blockers.length === 0,
    benchmarkRecommendsHardwareQa,
    blocker: blockers[0] ?? null,
    generatedAt:
      typeof runtimeReport?.generatedAt === "string"
        ? runtimeReport.generatedAt
        : typeof agentProofReport?.generatedAt === "string"
          ? agentProofReport.generatedAt
          : null,
    hardwareQaModel,
    hardwareQaPromoted,
    modelRef,
    providerConfigured,
    providerId,
    runtimeReady,
    runtimeReportPath: repoPath(runtimeReportPath),
    runtimeStatus: typeof diagnostic.status === "string" ? diagnostic.status : "missing",
  };
}

type StanskiProductionRunner = (args: JsonRecord) => Promise<StanskiProductionStatusSnapshot>;

async function runDefaultStanskiProduction(
  args: JsonRecord,
): Promise<StanskiProductionStatusSnapshot> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "scripts", "lib", "stanski-production-loop.mjs"),
  ).href;
  const module = (await import(moduleUrl)) as {
    runStanskiProduction?: (args: JsonRecord) => Promise<unknown>;
  };
  if (typeof module.runStanskiProduction !== "function") {
    throw new Error("Stanski production runner is not available");
  }
  const result = await module.runStanskiProduction(args);
  return isRecord(result)
    ? ({
        ...result,
        status: typeof result.status === "string" ? result.status : "unknown",
      } as StanskiProductionStatusSnapshot)
    : { status: "invalid", blocker: "Stanski production runner returned a non-object result" };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function createStanskiProductionRunArgs(
  mode:
    | "auto"
    | "cancel"
    | "continue"
    | "pause"
    | "resume"
    | "retry-blocked"
    | "split-next"
    | "status",
  params: unknown,
): JsonRecord {
  const request = asRecord(params);
  if (mode === "status") {
    return { mode, runSmoke: false };
  }
  if (mode === "pause" || mode === "resume" || mode === "cancel" || mode === "split-next") {
    return { mode, runSmoke: false };
  }
  if (mode === "auto") {
    return {
      maxMilestones: boundedInteger(request.maxMilestones, 40, 1, 40),
      maxRuntimeMinutes: boundedInteger(request.maxRuntimeMinutes, 30, 1, 30),
      mode,
      runSmoke: request.runSmoke === false ? false : true,
      until: typeof request.until === "string" ? request.until : "blocked",
    };
  }
  const maxMilestones = boundedInteger(request.maxMilestones, 1, 1, 40);
  return {
    maxMilestones,
    mode,
    runSmoke: request.runSmoke === false ? false : true,
  };
}

function snesToolchainHome() {
  return process.env.OPENCLAW_SNES_TOOLCHAIN_HOME
    ? path.resolve(process.env.OPENCLAW_SNES_TOOLCHAIN_HOME)
    : path.join(homedir(), ".openclaw", "snes-toolchain");
}

function snesToolchainManifestPath() {
  return path.join(snesToolchainHome(), "toolchain-manifest.json");
}

async function loadSnesToolchainManifest(): Promise<JsonRecord> {
  return (await readJsonFile(snesToolchainManifestPath())) ?? {};
}

function manifestToolCandidates(manifest: JsonRecord, id: SnesToolchainToolId): string[] {
  const tools = asRecord(manifest.tools);
  const record = asRecord(tools[id]);
  return [record.path, record.home, ...(Array.isArray(record.paths) ? record.paths : [])].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function manifestReceiptSummary(manifest: JsonRecord): JsonRecord {
  return asRecord(manifest.lastReceipts);
}

const TOOLCHAIN_CANDIDATES: Record<
  SnesToolchainToolId,
  { commands: string[]; env?: string; paths: string[] }
> = {
  aseprite: {
    commands: ["aseprite"],
    paths: ["/Applications/Aseprite.app", "/opt/homebrew/bin/aseprite", "/usr/local/bin/aseprite"],
  },
  brrtools: {
    commands: ["brr_encoder", "brrencode", "brrtools"],
    paths: ["/opt/homebrew/bin/brr_encoder", "/usr/local/bin/brr_encoder"],
  },
  bsnes: {
    commands: ["bsnes"],
    paths: ["/Applications/bsnes.app", "/opt/homebrew/bin/bsnes", "/usr/local/bin/bsnes"],
  },
  ldtk: {
    commands: ["ldtk", "LDtk"],
    paths: ["/Applications/LDtk.app", "/Applications/LDtk.app/Contents/MacOS/LDtk"],
  },
  mesen: {
    commands: ["mesen", "mesen2", "Mesen"],
    paths: ["/Applications/Mesen.app", "/Applications/MesenCE.app", "/opt/homebrew/bin/mesen"],
  },
  pixelorama: {
    commands: ["pixelorama", "Pixelorama"],
    paths: [
      "/Applications/Pixelorama.app",
      "/Applications/Pixelorama.app/Contents/MacOS/Pixelorama",
    ],
  },
  pvsneslib: {
    commands: ["pvsneslib", "pvsneslib-config"],
    env: "PVSNESLIB_HOME",
    paths: ["/opt/pvsneslib", "/usr/local/pvsneslib", "/opt/devkitpro/pvsneslib"],
  },
  superfamicheck: {
    commands: ["superfamicheck"],
    paths: ["/opt/homebrew/bin/superfamicheck", "/usr/local/bin/superfamicheck"],
  },
  superfamiconv: {
    commands: ["superfamiconv"],
    paths: ["/opt/homebrew/bin/superfamiconv", "/usr/local/bin/superfamiconv"],
  },
  tiled: {
    commands: ["tiled", "Tiled"],
    paths: ["/Applications/Tiled.app", "/Applications/Tiled.app/Contents/MacOS/Tiled"],
  },
};

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findCommandOnPath(command: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findToolPath(
  id: SnesToolchainToolId,
  manifest: JsonRecord = {},
): Promise<string | null> {
  const definition = TOOLCHAIN_CANDIDATES[id];
  const envPath = definition.env ? process.env[definition.env] : undefined;
  if (envPath && (await pathExists(envPath))) {
    return envPath;
  }
  for (const candidate of [
    path.join(snesToolchainHome(), "bin", ...definition.commands.slice(0, 1)),
    ...manifestToolCandidates(manifest, id),
  ]) {
    if (candidate && (await pathExists(candidate))) {
      return candidate;
    }
  }
  for (const command of definition.commands) {
    const commandPath = await findCommandOnPath(command);
    if (commandPath) {
      return commandPath;
    }
  }
  for (const candidate of definition.paths) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function detectFxpakVolume(): Promise<SnesToolchainDoctorInput["fxpakVolume"]> {
  const explicitVolume = process.env.OPENCLAW_SNES_FXPAK_VOLUME;
  if (explicitVolume) {
    return {
      detail: "FXPAK/SD2SNES volume path came from OPENCLAW_SNES_FXPAK_VOLUME.",
      fileSystem: process.env.OPENCLAW_SNES_FXPAK_FILESYSTEM ?? "unknown",
      mounted: await pathExists(explicitVolume),
      path: explicitVolume,
    };
  }
  const volumesRoot = "/Volumes";
  let entries: string[];
  try {
    entries = await readdir(volumesRoot);
  } catch {
    return { detail: "/Volumes is not readable on this host.", mounted: false };
  }
  const match = entries.find((entry) => /fxpak|sd2snes|sd2-snes|sd2 snes/iu.test(entry));
  if (!match) {
    return { detail: "No FXPAK/SD2SNES-style volume name found under /Volumes.", mounted: false };
  }
  const volumePath = path.join(volumesRoot, match);
  return {
    detail:
      "FXPAK/SD2SNES-style volume was detected by name; set OPENCLAW_SNES_FXPAK_FILESYSTEM=fat32 to mark FAT32 proof.",
    fileSystem: process.env.OPENCLAW_SNES_FXPAK_FILESYSTEM ?? "unknown",
    mounted: true,
    path: volumePath,
  };
}

export async function loadSnesToolchainStatusSnapshot(): Promise<SnesToolchainStatusSnapshot> {
  const manifest = await loadSnesToolchainManifest();
  const tools: SnesToolchainDoctorInput["tools"] = {};
  for (const id of Object.keys(TOOLCHAIN_CANDIDATES) as SnesToolchainToolId[]) {
    const detectedPath = await findToolPath(id, manifest);
    tools[id] = detectedPath
      ? {
          available: true,
          detail: `${id} detected read-only at ${repoPath(detectedPath)}.`,
          path: detectedPath,
        }
      : {
          available: false,
          detail: `${id} was not detected on PATH, common macOS app paths, or configured env paths.`,
        };
  }
  return {
    ...createSnesToolchainDoctorReport({
      fxpakVolume: await detectFxpakVolume(),
      tools,
    }),
    generatedAt: new Date().toISOString(),
    liveProbe: true,
    manifestPath: snesToolchainManifestPath(),
    receiptSummary: manifestReceiptSummary(manifest),
    toolchainHome: snesToolchainHome(),
  };
}

function sanitizeProjectId(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "comet-fox-mvp";
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return sanitized || "comet-fox-mvp";
}

function snesProjectsRoot() {
  return process.env.OPENCLAW_SNES_PROJECTS_ARTIFACT_DIR
    ? path.resolve(process.env.OPENCLAW_SNES_PROJECTS_ARTIFACT_DIR)
    : path.join(process.cwd(), ".artifacts", "snes-projects");
}

function productionPaths(projectId: string) {
  const projectDir = path.join(snesProjectsRoot(), projectId);
  const productionDir = path.join(projectDir, "production");
  return {
    backlogPath: path.join(productionDir, "backlog.json"),
    controlPath: path.join(productionDir, "control.json"),
    decisionLogPath: path.join(productionDir, "decision-log.json"),
    latestSummaryPath: path.join(productionDir, "latest-summary.md"),
    memoryCardsPath: path.join(productionDir, "memory-cards.json"),
    productionDir,
    projectDir,
    projectPath: path.join(projectDir, "project.json"),
    statePath: path.join(productionDir, "state.json"),
    toolchainDir: path.join(projectDir, "toolchain"),
  };
}

async function writeJsonFile(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}
`,
  );
}

async function readJsonRecord(filePath: string): Promise<JsonRecord | null> {
  return readJsonFile(filePath);
}

async function loadProjectToolchainReceipt(
  projectId: string,
  kind: string,
): Promise<JsonRecord | null> {
  const paths = productionPaths(projectId);
  return readJsonRecord(path.join(paths.toolchainDir, `latest-${kind}.json`));
}

async function loadProjectToolchainProof(projectId: string): Promise<JsonRecord> {
  const [
    audioCompile,
    artManifest,
    artCompile,
    conversion,
    visualProof,
    visualApproval,
    rom,
    engineRom,
    emulator,
    engineEmulator,
    fxpakDryRun,
    fxpakTransferPackage,
    fxpakCopy,
  ] = await Promise.all([
    loadProjectToolchainReceipt(projectId, "audio-compile"),
    loadProjectToolchainReceipt(projectId, "art-manifest"),
    loadProjectToolchainReceipt(projectId, "art-compile"),
    loadProjectToolchainReceipt(projectId, "conversion"),
    loadProjectToolchainReceipt(projectId, "visual-proof"),
    loadProjectToolchainReceipt(projectId, "visual-approval"),
    loadProjectToolchainReceipt(projectId, "rom"),
    loadProjectToolchainReceipt(projectId, "engine-rom"),
    loadProjectToolchainReceipt(projectId, "emulator"),
    loadProjectToolchainReceipt(projectId, "engine-emulator"),
    loadProjectToolchainReceipt(projectId, "fxpak-dry-run"),
    loadProjectToolchainReceipt(projectId, "fxpak-transfer-package"),
    loadProjectToolchainReceipt(projectId, "fxpak-copy"),
  ]);
  return {
    audioCompile,
    artCompile,
    artManifest,
    assetConversion: conversion,
    engineEmulator,
    engineRom,
    emulator,
    fxpak: fxpakCopy?.status === "pass" ? fxpakCopy : fxpakDryRun,
    fxpakCopy,
    fxpakDryRun,
    fxpakTransferPackage,
    rom,
    visualApproval,
    visualProof,
  };
}

function receiptStatus(receipt: JsonRecord | null): string {
  return typeof receipt?.status === "string" ? receipt.status : "not-run";
}

function visualApprovalReceiptForReadiness(receipt: JsonRecord | null): JsonRecord | undefined {
  if (!receipt || receipt.status !== "pass") {
    return undefined;
  }
  const humanScore = typeof receipt.humanScore === "number" ? receipt.humanScore : null;
  const targetScore = typeof receipt.targetScore === "number" ? receipt.targetScore : 100;
  return {
    blocker: null,
    currentHumanScore: humanScore,
    gpt55ReviewStatus: "not-requested",
    machineScore: humanScore,
    status: humanScore !== null && humanScore >= targetScore ? "approved" : "manual-required",
    targetScore,
  };
}

function createGenericSamplePackage(projectId: string, projectName?: string): SnesProjectPackage {
  if (projectId === "stanskis-world-canary" || /stanski/iu.test(projectId)) {
    return createStanskiCanaryProjectPackage();
  }
  if (projectId === "comet-fox-mvp") {
    return createSnesMvpSampleProjectPackage();
  }
  const project = createDefaultSnesStudioProject(new Date().toISOString());
  project.id = projectId;
  project.name = projectName || `SNES Project ${projectId}`;
  return createSnesProjectPackage(project, { source: "generic" });
}

async function loadOrCreateSnesProjectPackage(params: unknown): Promise<SnesProjectPackage> {
  const request = asRecord(params);
  const projectId = sanitizeProjectId(request.projectId);
  const paths = productionPaths(projectId);
  const raw = await readJsonRecord(paths.projectPath);
  if (raw) {
    return parseSnesProjectPackage(JSON.stringify(raw));
  }
  const projectPackage = createGenericSamplePackage(
    projectId,
    typeof request.projectName === "string" ? request.projectName : undefined,
  );
  await writeJsonFile(paths.projectPath, projectPackage);
  return projectPackage;
}

async function loadOrCreateGenericState(
  projectPackage: SnesProjectPackage,
): Promise<SnesGenericProductionState> {
  const paths = productionPaths(projectPackage.projectId);
  const rawState = await readJsonRecord(paths.statePath);
  if (rawState?.format === "openclaw-snes-generic-production-state") {
    return rawState as SnesGenericProductionState;
  }
  const state = createSnesGenericProductionState(projectPackage.manifest.project);
  await writeJsonFile(paths.statePath, state);
  await writeJsonFile(paths.backlogPath, state.backlog);
  await writeJsonFile(paths.memoryCardsPath, state.memoryCards);
  return state;
}

async function readControl(paths: ReturnType<typeof productionPaths>): Promise<JsonRecord> {
  return (
    (await readJsonRecord(paths.controlPath)) ?? {
      cancelRequested: false,
      paused: false,
      updatedAt: new Date().toISOString(),
    }
  );
}

async function appendDecisionLog(projectId: string, entry: JsonRecord) {
  const paths = productionPaths(projectId);
  const existing = await readJsonRecord(paths.decisionLogPath);
  const entries = Array.isArray(existing?.entries) ? existing.entries : [];
  await writeJsonFile(paths.decisionLogPath, {
    entries: [...entries, { ...entry, at: new Date().toISOString() }],
  });
}

async function persistGenericState(state: SnesGenericProductionState) {
  const paths = productionPaths(state.projectId);
  await writeJsonFile(paths.statePath, state);
  await writeJsonFile(paths.backlogPath, state.backlog);
  await writeJsonFile(paths.memoryCardsPath, state.memoryCards);
  await writeFile(
    paths.latestSummaryPath,
    [
      "# Generic SNES Production Runner",
      "",
      `Project: ${state.projectId}`,
      `Current milestone: ${state.currentMilestoneId ?? "complete"}`,
      `Completed: ${state.completedMilestones.length}/${state.backlog.length}`,
      `Blocked: ${state.blockedMilestone ?? "none"}`,
      "Hosted GLM used: no",
      "Routine GPT 5.5 used: no",
      "",
    ].join("\n"),
  );
}

function createDeterministicGenericPatch(state: SnesGenericProductionState): JsonRecord {
  const milestone = state.backlog.find((entry) => entry.id === state.currentMilestoneId) ?? null;
  if (!milestone) {
    return {};
  }
  return {
    [milestone.patchSchema]: {
      acceptance: milestone.acceptance,
      projectId: state.projectId,
      receipt: "deterministic generic SNES Builder contract proof",
    },
    hostedGlmUsed: false,
    localGlmOnly: true,
    milestoneId: milestone.id,
    patchType: milestone.patchSchema,
    summary: `${milestone.name} passed through the generic persisted SNES production runner.`,
  };
}

function splitCurrentGenericMilestone(
  state: SnesGenericProductionState,
): SnesGenericProductionState {
  const current = state.backlog.find((milestone) => milestone.id === state.currentMilestoneId);
  if (!current || current.id !== "GEN02") {
    return state;
  }
  const children = [
    {
      ...current,
      acceptance: ["Pixelorama sprite folder contract receipt exists", "no external install runs"],
      goal: "Create Pixelorama-compatible sprite folder adapter receipts.",
      id: "GEN02a",
      name: "Pixelorama asset folder adapter",
    },
    {
      ...current,
      acceptance: ["Superfamiconv tile conversion receipt exists", "input hash binds output plan"],
      goal: "Create Superfamiconv conversion adapter receipts.",
      id: "GEN02b",
      name: "Superfamiconv conversion adapter",
    },
    {
      ...current,
      acceptance: ["LDtk/Tiled level import receipts exist", "missing tools report blockers"],
      goal: "Create LDtk/Tiled level data adapter receipts.",
      id: "GEN02c",
      name: "Level editor adapter receipts",
    },
    {
      ...current,
      acceptance: ["BRR audio conversion receipt exists", "SPC700 handoff blocker is explicit"],
      goal: "Create BRR audio conversion adapter receipt.",
      id: "GEN02d",
      name: "BRR audio adapter receipt",
    },
    {
      ...current,
      acceptance: [
        "asset registry still blocks prose-only production",
        "visual gate remains honest",
      ],
      goal: "Integrate adapter receipts into production asset gates.",
      id: "GEN02e",
      name: "Asset adapter integration QA",
    },
  ];
  const backlog = state.backlog.flatMap((milestone) =>
    milestone.id === current.id ? children : [milestone],
  );
  return { ...state, backlog, currentMilestoneId: "GEN02a" };
}

async function buildGenericProductionSnapshot(
  projectPackage: SnesProjectPackage,
  state: SnesGenericProductionState,
): Promise<SnesGenericProductionSnapshot> {
  const paths = productionPaths(projectPackage.projectId);
  const toolchain = await loadSnesToolchainStatusSnapshot();
  const projectProof = await loadProjectToolchainProof(projectPackage.projectId);
  const audioCompileReceipt = asRecord(projectProof.audioCompile);
  const artCompileReceipt = asRecord(projectProof.artCompile);
  const artManifestReceipt = asRecord(projectProof.artManifest);
  const conversionReceipt = asRecord(projectProof.assetConversion);
  const engineEmulatorReceipt = asRecord(projectProof.engineEmulator);
  const engineRomReceipt = asRecord(projectProof.engineRom);
  const emulatorReceipt = asRecord(projectProof.emulator);
  const fxpakReceipt = asRecord(projectProof.fxpak);
  const fxpakTransferPackageReceipt = asRecord(projectProof.fxpakTransferPackage);
  const romReceipt = asRecord(projectProof.rom);
  const visualApprovalReceipt = asRecord(projectProof.visualApproval);
  const visualProofReceipt = asRecord(projectProof.visualProof);
  const receiptAssetRecords = Array.isArray(conversionReceipt.assetRecords)
    ? (conversionReceipt.assetRecords as never[])
    : [];
  const packageAssetRecords = Array.isArray(projectPackage.manifest.assetRegistry.records)
    ? (projectPackage.manifest.assetRegistry.records as never[])
    : [];
  const productionAssetRecords =
    visualApprovalReceipt?.status === "pass" && packageAssetRecords.length > 0
      ? packageAssetRecords
      : receiptAssetRecords;
  const productionReadiness = createSnesProductionReadinessReport(projectPackage.manifest.project, {
    assetRecords: productionAssetRecords,
    engineRuntimeProof: asRecord(engineRomReceipt.engineRuntimeProof) as never,
    emulatorProof: asRecord(emulatorReceipt.emulatorProof) as never,
    fxpakPackage: fxpakReceipt as never,
    romBuild: romReceipt as never,
    toolchain,
    visualApproval:
      visualApprovalReceiptForReadiness(visualApprovalReceipt) ??
      projectPackage.manifest.productionReadiness.visualApproval,
  });
  const adapterPlan = createSnesAssetAdapterPlan(projectPackage.manifest.project, toolchain);
  const romScaffold = createSnesRomBuildScaffoldDryRun(projectPackage.manifest.project, toolchain);
  const emulatorPlan = createSnesEmulatorProofPlanFromToolchain(
    projectPackage.manifest.project,
    toolchain,
  );
  const fxpakPlan = createSnesFxpakDryRunPlan(projectPackage.manifest.project, {
    volumePath: toolchain.fxpakVolume.path,
  });
  const currentMilestone =
    state.backlog.find((milestone) => milestone.id === state.currentMilestoneId) ?? null;
  const control = await readControl(paths);
  const status =
    control.paused === true
      ? "paused"
      : state.blockedMilestone
        ? "blocked"
        : state.currentMilestoneId
          ? "ready"
          : "complete";
  return {
    adapterPlan,
    blocker: state.blockedMilestone,
    completedCount: state.completedMilestones.length,
    control,
    currentMilestone,
    emulatorPlan,
    fxpakPlan,
    gpt55Used: false,
    latestReceipt: state.receipts.at(-1) ?? null,
    localGlmOnly: true,
    nextMilestone: currentMilestone,
    packet: createSnesGenericProductionPacket(state),
    paths: {
      backlogPath: repoPath(paths.backlogPath),
      latestSummaryPath: repoPath(paths.latestSummaryPath),
      memoryCardsPath: repoPath(paths.memoryCardsPath),
      productionDir: repoPath(paths.productionDir),
      projectPath: repoPath(paths.projectPath),
      statePath: repoPath(paths.statePath),
    },
    projectId: projectPackage.projectId,
    projectName: projectPackage.projectName,
    projectProof: {
      ...projectProof,
      productionReadiness,
      statuses: {
        artCompile: receiptStatus(artCompileReceipt),
        artManifest: receiptStatus(artManifestReceipt),
        assetConversion: receiptStatus(conversionReceipt),
        audioCompile: receiptStatus(audioCompileReceipt),
        engineEmulator: receiptStatus(engineEmulatorReceipt),
        engineRom: receiptStatus(engineRomReceipt),
        emulator: receiptStatus(emulatorReceipt),
        fxpak: receiptStatus(fxpakReceipt),
        fxpakTransferPackage: receiptStatus(fxpakTransferPackageReceipt),
        rom: receiptStatus(romReceipt),
        visualApproval: receiptStatus(visualApprovalReceipt),
        visualProof: receiptStatus(visualProofReceipt),
      },
    },
    projectPackage,
    romScaffold,
    state,
    status,
    toolchain,
    totalCount: state.backlog.length,
    workerMode: "deterministic-contract-proof",
  };
}

async function runDefaultGenericProduction(
  params: unknown,
  mode: string,
): Promise<SnesGenericProductionSnapshot> {
  const request = asRecord(params);
  const projectPackage = await loadOrCreateSnesProjectPackage(request);
  const paths = productionPaths(projectPackage.projectId);
  let state = await loadOrCreateGenericState(projectPackage);
  if (mode === "pause" || mode === "resume" || mode === "cancel") {
    const control = {
      cancelRequested: mode === "cancel",
      paused: mode === "pause" ? true : mode === "resume" ? false : true,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(paths.controlPath, control);
    await appendDecisionLog(projectPackage.projectId, { mode, status: "control-updated" });
    return buildGenericProductionSnapshot(projectPackage, state);
  }
  if (mode === "split-next") {
    state = splitCurrentGenericMilestone(state);
    await persistGenericState(state);
    await appendDecisionLog(projectPackage.projectId, { mode, status: "split" });
    return buildGenericProductionSnapshot(projectPackage, state);
  }
  const control = await readControl(paths);
  if (control.paused === true && mode !== "status") {
    return buildGenericProductionSnapshot(projectPackage, state);
  }
  if (mode === "retry-blocked" && state.blockedMilestone) {
    state = {
      ...state,
      blockedMilestone: null,
      currentMilestoneId: state.blockedMilestone,
    };
  }
  if (mode === "continue" || mode === "auto" || mode === "retry-blocked") {
    const maxMilestones =
      mode === "auto"
        ? boundedInteger(request.maxMilestones, 40, 1, 40)
        : boundedInteger(request.maxMilestones, 1, 1, 40);
    for (let index = 0; index < maxMilestones; index += 1) {
      if (!state.currentMilestoneId || state.blockedMilestone) {
        break;
      }
      const patch = isRecord(request.patch)
        ? request.patch
        : createDeterministicGenericPatch(state);
      const result = applySnesGenericProductionPatch(state, patch);
      state = result.state;
      await appendDecisionLog(projectPackage.projectId, {
        mode,
        milestoneId: result.validation.milestoneId,
        status: result.status,
        validation: result.validation,
      });
      if (result.status === "blocked") {
        break;
      }
      if (mode !== "auto") {
        break;
      }
    }
    await persistGenericState(state);
  } else {
    await persistGenericState(state);
  }
  return buildGenericProductionSnapshot(projectPackage, state);
}

function execFileJson(command: string, args: string[]): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout || error.message}`),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as JsonRecord);
        } catch {
          reject(
            new Error(`SNES toolchain action returned non-JSON output: ${stdout.slice(0, 1000)}`),
          );
        }
      },
    );
  });
}

function proofActionArgs(actionId: SnesGenericProofActionId): string[] {
  const referenceRoot = path.join(".artifacts", "snes-game-builder-reference");
  if (actionId === "mastery-refresh") {
    return [path.join(referenceRoot, "scripts", "snes-mastery-harness.mjs"), "refresh", "--json"];
  }
  if (actionId === "budget-enforcement") {
    return [path.join(referenceRoot, "scripts", "validate-generic-budget-enforcement.mjs")];
  }
  if (actionId === "runtime-asset-truth") {
    return [path.join(referenceRoot, "scripts", "validate-generic-runtime-asset-truth.mjs")];
  }
  if (actionId === "generic-project-gate") {
    return [path.join(referenceRoot, "scripts", "validate-generic-project-generator-gate.mjs")];
  }
  if (actionId === "fxpak-package-dry-run") {
    return [path.join(referenceRoot, "scripts", "validate-generic-receipts.mjs")];
  }
  if (actionId === "emulator-headless") {
    return [
      "--import",
      "tsx",
      path.join("scripts", "dev", "snes-emulator-headless-proof.ts"),
      "--rom",
      path.join(
        referenceRoot,
        "katas",
        "kata-012-full-finishable-level-route",
        "openclaw_snes_kata_012.sfc",
      ),
      "--artifact-dir",
      path.join(
        referenceRoot,
        "katas",
        "kata-013-emulator-screenshot-regression",
        "dashboard-headless-proof",
      ),
      "--json",
    ];
  }
  return ["--import", "tsx", path.join("scripts", "dev", "control-ui-snes-studio-smoke.ts")];
}

function parseProofActionId(params: unknown): SnesGenericProofActionId {
  const actionId = asRecord(params).actionId;
  const allowed: SnesGenericProofActionId[] = [
    "browser-smoke",
    "budget-enforcement",
    "emulator-headless",
    "fxpak-package-dry-run",
    "generic-project-gate",
    "mastery-refresh",
    "runtime-asset-truth",
  ];
  if (typeof actionId === "string" && allowed.includes(actionId as SnesGenericProofActionId)) {
    return actionId as SnesGenericProofActionId;
  }
  return "mastery-refresh";
}

async function runDefaultGenericProofAction(
  params: unknown,
): Promise<SnesGenericProofActionReceipt> {
  const actionId = parseProofActionId(params);
  if (actionId === "browser-smoke") {
    await execFileJson(process.execPath, ["scripts/ensure-playwright-chromium.mjs", "--json"]);
  }
  const args = proofActionArgs(actionId);
  const summary = await execFileJson(process.execPath, args);
  const status =
    typeof summary.status === "string" ? summary.status : summary.ok === true ? "pass" : "unknown";
  const blockers = Array.isArray(summary.blockers)
    ? summary.blockers.filter((blocker): blocker is string => typeof blocker === "string")
    : typeof summary.blocker === "string" && summary.blocker
      ? [summary.blocker]
      : [];
  return {
    actionId,
    blocker: blockers[0] ?? null,
    blockers,
    command: `${process.execPath} ${args.join(" ")}`,
    generatedAt: new Date().toISOString(),
    hostedGlmUsed: false,
    localOnly: true,
    projectSpecific: false,
    removableMediaWritePerformed: false,
    status,
    summary,
  };
}

async function runDefaultToolchainProjectAction(
  params: unknown,
  mode: string,
): Promise<JsonRecord> {
  const request = asRecord(params);
  const projectId = sanitizeProjectId(request.projectId);
  const args = ["scripts/snes-toolchain.mjs", mode, "--project-id", projectId, "--json"];
  if (typeof request.assetId === "string" && request.assetId.trim()) {
    args.push("--asset-id", request.assetId.trim());
  }
  if (mode === "visual-reject") {
    const humanScore =
      typeof request.humanScore === "number" || typeof request.humanScore === "string"
        ? String(request.humanScore)
        : "2";
    args.push("--human-score", humanScore);
  }
  if (mode === "project-visual-approval") {
    const humanScore =
      typeof request.humanScore === "number" || typeof request.humanScore === "string"
        ? String(request.humanScore)
        : "100";
    args.push("--human-score", humanScore);
    if (request.confirmHumanReviewedVisuals === true) {
      args.push("--confirm-human-reviewed-visuals");
    }
    if (typeof request.reviewNote === "string" && request.reviewNote.trim()) {
      args.push("--review-note", request.reviewNote.trim());
    }
    args.push(
      "--approver",
      typeof request.approver === "string" && request.approver.trim()
        ? request.approver.trim()
        : "dashboard-human-operator",
    );
  }
  const report = await execFileJson(process.execPath, args);
  return {
    ...report,
    dashboardAction: mode,
    projectId,
  };
}

async function createBlankSnesProjectReceipt(params: unknown): Promise<SnesBlankProjectReceipt> {
  const request = asRecord(params);
  const project = createDefaultSnesStudioProject(new Date().toISOString());
  project.id = sanitizeProjectId(request.projectId);
  project.name =
    typeof request.projectName === "string" && request.projectName.trim()
      ? request.projectName.trim()
      : "Blank SNES Platformer";
  project.updatedAt = new Date().toISOString();
  const projectPackage = createSnesProjectPackage(project, {
    source: "generic",
    createdAt: project.updatedAt,
  });
  const paths = productionPaths(project.id);
  await mkdir(paths.projectDir, { recursive: true });
  await writeFile(paths.projectPath, `${JSON.stringify(projectPackage, null, 2)}\n`);
  return {
    generatedAt: new Date().toISOString(),
    hostedGlmUsed: false,
    localOnly: true,
    packageHash: projectPackage.packageHash,
    packagePath: repoPath(paths.projectPath),
    projectId: projectPackage.projectId,
    projectName: projectPackage.projectName,
    projectSpecific: false,
    proofClaim: "project-package-created-only",
    removableMediaWritePerformed: false,
    status: "pass",
  };
}

type SnesGenericProductionRunner = (
  params: unknown,
  mode: string,
) => Promise<SnesGenericProductionSnapshot>;

type SnesToolchainProjectActionRunner = (params: unknown, mode: string) => Promise<JsonRecord>;
type SnesGenericProofActionRunner = (params: unknown) => Promise<SnesGenericProofActionReceipt>;

export function createSnesStudioBenchmarkHandlers(params?: {
  loadSnapshot?: () => Promise<SnesBenchmarkLatestSnapshot>;
  loadGlm52Status?: (config: JsonRecord) => Promise<SnesGlm52StatusSnapshot>;
  loadMasteryStatus?: () => Promise<SnesMasteryStatusSnapshot>;
  loadToolchainStatus?: () => Promise<SnesToolchainStatusSnapshot>;
  runGenericProduction?: SnesGenericProductionRunner;
  runStanskiProduction?: StanskiProductionRunner;
  runToolchainProjectAction?: SnesToolchainProjectActionRunner;
  runGenericProofAction?: SnesGenericProofActionRunner;
  createBlankProject?: (params: unknown) => Promise<SnesBlankProjectReceipt>;
}): GatewayRequestHandlers {
  const loadSnapshot = params?.loadSnapshot ?? loadSnesBenchmarkLatestSnapshot;
  const loadGlm52Status =
    params?.loadGlm52Status ?? ((config: JsonRecord) => loadSnesGlm52StatusSnapshot({ config }));
  const loadMasteryStatus = params?.loadMasteryStatus ?? loadSnesMasteryStatusSnapshot;
  const loadToolchainStatus = params?.loadToolchainStatus ?? loadSnesToolchainStatusSnapshot;
  const runGenericProduction = params?.runGenericProduction ?? runDefaultGenericProduction;
  const runStanskiProduction = params?.runStanskiProduction ?? runDefaultStanskiProduction;
  const runToolchainProjectAction =
    params?.runToolchainProjectAction ?? runDefaultToolchainProjectAction;
  const runGenericProofAction = params?.runGenericProofAction ?? runDefaultGenericProofAction;
  const createBlankProject = params?.createBlankProject ?? createBlankSnesProjectReceipt;
  return {
    "snes.benchmark.latest": async ({ respond }) => {
      try {
        respond(true, await loadSnapshot());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES benchmark report unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.glm52.status": async ({ respond, context }) => {
      try {
        respond(true, await loadGlm52Status(context.getRuntimeConfig() as JsonRecord));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES GLM-5.2 status unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.mastery.status": async ({ respond }) => {
      try {
        respond(true, await loadMasteryStatus());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES Mastery status unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.project.createBlank": async ({ respond, params }) => {
      try {
        respond(true, await createBlankProject(params));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES blank project creation failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.proof.run": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProofAction(params));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES proof action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.toolchain.status": async ({ respond }) => {
      try {
        respond(true, await loadToolchainStatus());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES Toolchain Doctor unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.reject": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "visual-reject"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES visual rejection action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.artBible": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-art-bible"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES art bible action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.artSourcePack": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-art-source-pack"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES art source-pack action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.artManifest": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-art-manifest"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES art manifest action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.compileArt": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-art-compile"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES art compile action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.captureProof": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-visual-proof"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES visual proof action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.runtimeAssetTruth": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-runtime-asset-truth"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES runtime asset truth failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.qualityAudit": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-visual-quality-audit"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES visual quality audit failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.visual.approve": async ({ respond, params }) => {
      try {
        respond(true, await runToolchainProjectAction(params, "project-visual-approval"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES visual approval action failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.status": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "status"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production status unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.continue": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "continue"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production runner failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.auto": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "auto"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production auto runner failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.pause": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "pause"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production pause failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.resume": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "resume"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production resume failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.cancel": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "cancel"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production cancel failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.splitNext": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "split-next"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production split failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.production.retryBlocked": async ({ respond, params }) => {
      try {
        respond(true, await runGenericProduction(params, "retry-blocked"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `SNES production retry failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },

    "snes.stanski.production.status": async ({ respond }) => {
      try {
        respond(true, await runStanskiProduction(createStanskiProductionRunArgs("status", {})));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production status unavailable: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.stanski.production.continue": async ({ respond, params }) => {
      try {
        respond(
          true,
          await runStanskiProduction(createStanskiProductionRunArgs("continue", params)),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production loop failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.stanski.production.auto": async ({ respond, params }) => {
      try {
        respond(true, await runStanskiProduction(createStanskiProductionRunArgs("auto", params)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production auto loop failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.stanski.production.pause": async ({ respond, params }) => {
      try {
        respond(true, await runStanskiProduction(createStanskiProductionRunArgs("pause", params)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production pause failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.stanski.production.resume": async ({ respond, params }) => {
      try {
        respond(true, await runStanskiProduction(createStanskiProductionRunArgs("resume", params)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production resume failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.stanski.production.cancel": async ({ respond, params }) => {
      try {
        respond(true, await runStanskiProduction(createStanskiProductionRunArgs("cancel", params)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production cancel failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.stanski.production.splitNext": async ({ respond, params }) => {
      try {
        respond(
          true,
          await runStanskiProduction(createStanskiProductionRunArgs("split-next", params)),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production split failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
    "snes.stanski.production.retryBlocked": async ({ respond, params }) => {
      try {
        respond(
          true,
          await runStanskiProduction(createStanskiProductionRunArgs("retry-blocked", params)),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `Stanski production retry failed: ${message}`, {
            retryable: true,
          }),
        );
      }
    },
  };
}

export const snesStudioBenchmarkHandlers = createSnesStudioBenchmarkHandlers();
