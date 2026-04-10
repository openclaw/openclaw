import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { loadAndMaybeMigrateDoctorConfig } from "../commands/doctor-config-flow.js";
import { noteSourceInstallIssues } from "../commands/doctor-install.js";
import { noteStartupOptimizationHints } from "../commands/doctor-platform-notes.js";
import { createDoctorPrompter, type DoctorOptions } from "../commands/doctor-prompter.js";
import { maybeRepairUiProtocolFreshness } from "../commands/doctor-ui.js";
import { maybeOfferUpdateBeforeDoctor } from "../commands/doctor-update.js";
import { printWizardHeader } from "../commands/onboard-helpers.js";
import { CONFIG_PATH } from "../config/config.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import {
  runDoctorHealthContributions,
  type DoctorHealthFlowContext,
} from "./doctor-health-contributions.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

function buildDoctorJsonSummary(params: {
  root: string;
  ctx: {
    cfg: DoctorHealthFlowContext["cfg"];
    configPath: string;
    sourceConfigValid: boolean;
    healthOk?: boolean;
    gatewayMemoryProbe?: DoctorHealthFlowContext["gatewayMemoryProbe"];
  };
}) {
  const channels = Object.entries(params.ctx.cfg.channels ?? {}).map(([name, value]) => ({
    name,
    enabled:
      typeof value === "object" && value !== null && "enabled" in value
        ? (value as { enabled?: unknown }).enabled === true
        : false,
  }));
  return {
    ok: true,
    command: "doctor",
    mode: params.ctx.cfg.gateway?.mode === "remote" ? "remote" : "local",
    configPath: params.ctx.configPath,
    packageRoot: params.root,
    sourceConfigValid: params.ctx.sourceConfigValid,
    healthOk: params.ctx.healthOk ?? null,
    gatewayMemoryProbe: params.ctx.gatewayMemoryProbe ?? null,
    channels,
    generatedAt: new Date().toISOString(),
  };
}

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const prompter = createDoctorPrompter({ runtime, options });
  const previousSuppressNotes = process.env.OPENCLAW_SUPPRESS_NOTES;

  if (options.json) {
    process.env.OPENCLAW_SUPPRESS_NOTES = "1";
  } else {
    printWizardHeader(runtime);
    intro("OpenClaw doctor");
  }

  try {
    const root = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });

    const updateResult = await maybeOfferUpdateBeforeDoctor({
      runtime,
      options,
      root,
      confirm: (p) => prompter.confirm(p),
      outro,
    });
    if (updateResult.handled) {
      return;
    }

    await maybeRepairUiProtocolFreshness(runtime, prompter);
    noteSourceInstallIssues(root);
    noteStartupOptimizationHints();

    const configResult = await loadAndMaybeMigrateDoctorConfig({
      options,
      confirm: (p) => prompter.confirm(p),
    });
    const ctx = {
      runtime,
      options,
      prompter,
      configResult,
      cfg: configResult.cfg,
      cfgForPersistence: structuredClone(configResult.cfg),
      sourceConfigValid: configResult.sourceConfigValid ?? true,
      configPath: configResult.path ?? CONFIG_PATH,
    };

    await runDoctorHealthContributions(ctx);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildDoctorJsonSummary({ root, ctx }), null, 2)}\n`);
      return;
    }

    outro("Doctor complete.");
  } finally {
    if (options.json) {
      if (previousSuppressNotes === undefined) {
        delete process.env.OPENCLAW_SUPPRESS_NOTES;
      } else {
        process.env.OPENCLAW_SUPPRESS_NOTES = previousSuppressNotes;
      }
    }
  }
}
