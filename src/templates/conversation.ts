export const TEMPLATE_AGENT_OPENING_MESSAGE = [
  "This ordinary conversation was just created from a Template. Your instruction files and active runtime are ready.",
  "Use your workspace instructions and SOUL personality. Give a brief, natural greeting and orientation in your own voice.",
  "The shared installer owns all remaining declared setup. Do not install integrations, create routines, change instructions, or duplicate setup. Tools are unavailable in this opening turn.",
  "Do not claim integrations or schedules are ready: the installer has not confirmed them yet. If useful, mention briefly that setup is continuing while you are here.",
  "Do not ask the user to choose a role or reconfigure the personality already provided by the Template.",
].join("\n\n");

/** One thing chat-based Add could not finish; the agent kept everything else. */
export type TemplateSetupFailure = {
  kind: "skill" | "plugin" | "mcpServer";
  name: string;
  reason: string;
};

/**
 * What chat-based Add leaves for the agent's first turn. Successful skills are
 * omitted: they are already in the workspace. Plugins the Template references
 * on ClawHub and its automations are never attempted, so they never appear here.
 */
export type TemplateSetupReport = {
  failures: TemplateSetupFailure[];
  /** Declared MCP servers now present in config, by name. */
  mcpServers: string[];
};

/** Facts for the opening turn, including when another device retries it. */
export type TemplateSetupOpening = {
  report: TemplateSetupReport;
  /** Absent when the adding device did not declare a valid zone; use the manifest. */
  deviceTimeZone?: string;
  /** Workspace is ready; dependency installation can overlap the first turn. */
  dependenciesPending?: true;
  /**
   * What the verified manifest declares for the conversation, so the first turn does not
   * spend model round trips rereading `CLAW.md`. Absent on a receipt saved before the
   * Gateway recorded it, or for an unusually large manifest; that turn reads the file.
   */
  declared?: TemplateSetupDeclarations;
};

/** Manifest entries the agent's first turn acts on, in manifest order. */
export type TemplateSetupDeclarations = {
  automations: { id: string; name: string; cron: string; timezone: string; message: string }[];
  /** Package names of plugins referenced on ClawHub; bundled plugins install with the Template. */
  plugins: string[];
};

/** The automations tool accepts at most this many slots in one plan. */
const MAX_DECLARED_AUTOMATIONS = 24;
/** Every declared plugin is named in the first message; a longer list stays in the manifest. */
const MAX_DECLARED_PLUGINS = 20;
/** Larger declarations stay in the manifest instead of the session receipt and first message. */
const MAX_DECLARED_BYTES = 16_384;

/** Copy only what the first turn needs from an already validated manifest. */
export function readTemplateSetupDeclarations(manifest: {
  automations?: readonly {
    id: string;
    name?: string;
    schedule: { cron: string; timezone: string };
    message: string;
  }[];
  plugins?: readonly unknown[];
}): TemplateSetupDeclarations | undefined {
  const declared: TemplateSetupDeclarations = {
    automations: (manifest.automations ?? []).map((job) => ({
      id: job.id,
      name: job.name ?? job.id,
      cron: job.schedule.cron,
      timezone: job.schedule.timezone,
      message: job.message,
    })),
    plugins: (manifest.plugins ?? []).flatMap((plugin) => {
      const ref =
        typeof plugin === "object" && plugin !== null && "ref" in plugin ? plugin.ref : undefined;
      return typeof ref === "string" ? [ref] : [];
    }),
  };
  return declared.automations.length <= MAX_DECLARED_AUTOMATIONS &&
    declared.plugins.length <= MAX_DECLARED_PLUGINS &&
    Buffer.byteLength(JSON.stringify(declared)) <= MAX_DECLARED_BYTES
    ? declared
    : undefined;
}
