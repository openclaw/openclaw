import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  BrowserWalkthroughStep,
  HarnessConfig,
  HarnessState,
  HarnessTicketOverride,
} from "./types.js";

const walkthroughStepSchema = z.object({
  action: z.enum([
    "open",
    "wait_load",
    "wait_for",
    "click",
    "fill",
    "type",
    "press",
    "scroll",
    "screenshot",
    "assert_text",
    "pause",
  ]),
  target: z.string().optional(),
  value: z.string().optional(),
  path: z.string().optional(),
  waitMs: z.number().int().positive().optional(),
  annotate: z.boolean().optional(),
  fullPage: z.boolean().optional(),
}) satisfies z.ZodType<BrowserWalkthroughStep>;

const agentSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  role: z.enum(["builder", "qa", "ux", "ai"]),
  model: z.string().optional(),
  instructionsFile: z.string().min(1),
  capabilities: z.string().optional(),
  search: z.boolean().optional(),
  dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
});

const ticketOverrideSchema: z.ZodType<HarnessTicketOverride> = z.object({
  summary: z.string().optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  startupCommand: z.string().min(1).optional(),
  healthcheckUrl: z.string().url().optional(),
  browserWalkthrough: z.array(walkthroughStepSchema).optional(),
  reviewRoles: z.array(z.enum(["qa", "ux", "ai"])).optional(),
  notionUrls: z.array(z.string().url()).optional(),
  relevantScreens: z.array(z.string().min(1)).optional(),
  environmentPrerequisites: z.array(z.string().min(1)).optional(),
  requiredArtifacts: z.array(z.string().min(1)).optional(),
});

const configSchema: z.ZodType<HarnessConfig> = z.object({
  paperclip: z.object({
    apiBase: z.string().url(),
    companyName: z.string().min(1),
    projectName: z.string().min(1),
  }),
  linear: z.object({
    teamKey: z.string().min(1),
    readyStateTypes: z.array(z.string().min(1)).min(1),
    readyStateNames: z.array(z.string().min(1)).min(1),
    preferredProjectNames: z.array(z.string().min(1)).optional(),
    excludedProjectNames: z.array(z.string().min(1)).optional(),
    listLimit: z.number().int().positive().optional(),
  }),
  notion: z.object({
    authEnv: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    baselineUrls: z.array(z.string().url()).optional(),
  }),
  workspace: z.object({
    repoKey: z.string().min(1),
    repoName: z.string().min(1),
    repoCwd: z.string().min(1),
    repoUrl: z.string().url().optional(),
    baseBranch: z.string().min(1),
    branchPrefix: z.string().min(1).optional(),
    ticketWorkspaceRootDir: z.string().min(1).optional(),
    installCommand: z.string().min(1).optional(),
    defaultStartupCommand: z.string().min(1).optional(),
    defaultHealthcheckUrl: z.string().url().optional(),
    defaultBrowserWalkthrough: z.array(walkthroughStepSchema).optional(),
  }),
  artifacts: z.object({
    rootDir: z.string().min(1),
  }),
  agents: z.object({
    builder: agentSchema,
    qa: agentSchema,
    ux: agentSchema.optional(),
    ai: agentSchema.optional(),
  }),
  reviewRules: z.object({
    default: z.array(z.enum(["qa", "ux", "ai"])).min(1),
    ui: z.array(z.enum(["qa", "ux", "ai"])).min(1),
    ai: z.array(z.enum(["qa", "ux", "ai"])).min(1),
  }),
  ticketOverrides: z.record(z.string(), ticketOverrideSchema).optional(),
});

const stateSchema = z.object({
  companyId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  projectWorkspaceId: z.string().uuid().optional(),
  paused: z.boolean().optional(),
  agentIds: z
    .object({
      builder: z.string().uuid().optional(),
      qa: z.string().uuid().optional(),
      ux: z.string().uuid().optional(),
      ai: z.string().uuid().optional(),
    })
    .partial()
    .optional(),
}) satisfies z.ZodType<HarnessState>;

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "operator-harness/harness.config.json");

export interface LoadedHarnessConfig {
  config: HarnessConfig;
  configPath: string;
  configDir: string;
  state: HarnessState;
  statePath: string;
}

function resolveMaybeRelative(value: string, configDir: string) {
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function resolveConfigPaths(config: HarnessConfig, configDir: string): HarnessConfig {
  return {
    ...config,
    workspace: {
      ...config.workspace,
      repoCwd: resolveMaybeRelative(config.workspace.repoCwd, configDir),
      ...(config.workspace.ticketWorkspaceRootDir
        ? {
            ticketWorkspaceRootDir: resolveMaybeRelative(
              config.workspace.ticketWorkspaceRootDir,
              configDir,
            ),
          }
        : {}),
    },
    artifacts: {
      ...config.artifacts,
      rootDir: resolveMaybeRelative(config.artifacts.rootDir, configDir),
    },
    agents: {
      builder: {
        ...config.agents.builder,
        instructionsFile: resolveMaybeRelative(config.agents.builder.instructionsFile, configDir),
      },
      qa: {
        ...config.agents.qa,
        instructionsFile: resolveMaybeRelative(config.agents.qa.instructionsFile, configDir),
      },
      ...(config.agents.ux
        ? {
            ux: {
              ...config.agents.ux,
              instructionsFile: resolveMaybeRelative(config.agents.ux.instructionsFile, configDir),
            },
          }
        : {}),
      ...(config.agents.ai
        ? {
            ai: {
              ...config.agents.ai,
              instructionsFile: resolveMaybeRelative(config.agents.ai.instructionsFile, configDir),
            },
          }
        : {}),
    },
  };
}

export async function loadHarnessConfig(
  configPath = process.env.OPENCLAW_OPERATOR_CONFIG ?? DEFAULT_CONFIG_PATH,
) {
  const resolvedConfigPath = path.resolve(configPath);
  const configDir = path.dirname(resolvedConfigPath);
  const raw = await fs.readFile(resolvedConfigPath, "utf8");
  const parsed = configSchema.parse(JSON.parse(raw));
  const resolved = resolveConfigPaths(parsed, configDir);
  const statePath = path.join(configDir, "harness.state.json");
  const stateRaw = await fs.readFile(statePath, "utf8").catch(() => "{}");
  const state = stateSchema.parse(JSON.parse(stateRaw));
  return {
    config: resolved,
    configPath: resolvedConfigPath,
    configDir,
    state,
    statePath,
  } satisfies LoadedHarnessConfig;
}

export async function saveHarnessState(input: LoadedHarnessConfig, nextState: HarnessState) {
  await fs.mkdir(path.dirname(input.statePath), { recursive: true });
  await fs.writeFile(input.statePath, JSON.stringify(nextState, null, 2));
}
