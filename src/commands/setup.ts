import fs from "node:fs/promises";
import { cancel, isCancel, select } from "@clack/prompts";
import JSON5 from "json5";
import { SEGMENT_TEMPLATES, type SegmentTemplate } from "../agents/workspace-templates.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../agents/workspace.js";
import { type OpenClawConfig, createConfigIO, writeConfigFile } from "../config/config.js";
import { formatConfigPath, logConfigUpdated } from "../config/logging.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

async function readConfigFileRaw(configPath: string): Promise<{
  exists: boolean;
  parsed: OpenClawConfig;
}> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { exists: true, parsed: parsed as OpenClawConfig };
    }
    return { exists: true, parsed: {} };
  } catch {
    return { exists: false, parsed: {} };
  }
}

const SEGMENT_LABELS: Record<SegmentTemplate | "default", { label: string; hint: string }> = {
  clinic: { label: "Clinica medica/odontologica", hint: "Agendamento, retornos, LGPD saude" },
  personal: { label: "Uso pessoal", hint: "Agenda, lembretes, produtividade" },
  construction: { label: "Construtora/incorporadora", hint: "Obras, investidores, vendas" },
  "law-firm": { label: "Escritorio de advocacia", hint: "Prazos, audiencias, sigilo" },
  default: { label: "Padrao (generico)", hint: "Templates originais do OpenClaw" },
};

async function promptSegment(): Promise<string> {
  const options = [
    ...SEGMENT_TEMPLATES.map((seg) => ({
      value: seg,
      label: SEGMENT_LABELS[seg].label,
      hint: SEGMENT_LABELS[seg].hint,
    })),
    {
      value: "default",
      label: SEGMENT_LABELS.default.label,
      hint: SEGMENT_LABELS.default.hint,
    },
  ];

  const result = await select({
    message: "Escolha o template do workspace:",
    options,
  });

  if (isCancel(result)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }

  return result;
}

export async function setupCommand(
  opts?: { workspace?: string; template?: string },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  // Resolve segment template
  let segment: string | undefined;
  if (typeof opts?.template === "string" && opts.template.trim()) {
    segment = opts.template.trim();
  } else if (process.stdout.isTTY) {
    segment = await promptSegment();
  }

  const io = createConfigIO();
  const configPath = io.configPath;
  const existingRaw = await readConfigFileRaw(configPath);
  const cfg = existingRaw.parsed;
  const defaults = cfg.agents?.defaults ?? {};

  const workspace = desiredWorkspace ?? defaults.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;

  const next: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        workspace,
      },
    },
  };

  if (!existingRaw.exists || defaults.workspace !== workspace) {
    await writeConfigFile(next);
    if (!existingRaw.exists) {
      runtime.log(`Wrote ${formatConfigPath(configPath)}`);
    } else {
      logConfigUpdated(runtime, { path: configPath, suffix: "(set agents.defaults.workspace)" });
    }
  } else {
    runtime.log(`Config OK: ${formatConfigPath(configPath)}`);
  }

  const ws = await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
    segment,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);

  if (segment && segment !== "default") {
    runtime.log(`Template: ${SEGMENT_LABELS[segment as SegmentTemplate]?.label ?? segment}`);
  }

  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}
