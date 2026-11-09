import { formatErrorMessage } from "../infra/errors.js";

export type UpdateSchemaRefusalDatabase = {
  kind: "state" | "agent";
  path: string;
  agentId?: string;
  foundVersion: number;
  supportedVersion: number;
};

/** An unfenced updater needs a manual update when safe publication deferral is unavailable. */
export class UpdateSchemaRefusalError extends Error {
  readonly code = "update-schema-bump-unfenced";
  readonly targetVersion: string;
  readonly commands: string[];

  constructor(
    readonly databases: readonly UpdateSchemaRefusalDatabase[],
    readonly updaterVersion: string,
    options: {
      targetVersion: string;
      cause?: unknown;
      recovery?: { message: string; commands: string[] };
    },
  ) {
    const { targetVersion } = options;
    const commands = options.recovery?.commands ?? [
      "openclaw gateway stop",
      `npm install -g openclaw@${targetVersion} --allow-scripts=openclaw`,
      "openclaw doctor --fix",
      "openclaw gateway start",
    ];
    const reason =
      options.cause === undefined
        ? ""
        : ` Deferral failed: ${formatErrorMessage(options.cause).slice(0, 600)}.`;
    const summary =
      `Doctor refused update-time schema repair driven by OpenClaw ${updaterVersion}: ` +
      "this updater reopens the ledger with old code after migration, and version publication could not be deferred safely.";
    const details = databases
      .map(
        (database) =>
          `${database.kind} database ${database.path}: on-disk schema ${database.foundVersion}, this build's schema ${database.supportedVersion}.`,
      )
      .join(" ");
    const unchanged = `${details}${reason} The blocked schema change was not applied.`;
    super(
      options.recovery
        ? `${summary} ${unchanged}\n${options.recovery.message}`
        : [
            // Shipped canaries retain bounded line tails, so keep the reason
            // separate from database paths and package-manager alternatives.
            summary,
            unchanged,
            "Let the updater restore the previous package and exit. Then use an independent shell with the original service account, package prefix, profile, and state/config overrides.",
            `Manual update: ${commands.join(" && ")}.`,
            `Use the package manager that owns this install (pnpm: pnpm add -g --allow-build=openclaw openclaw@${targetVersion}; Bun: bun add -g --trust openclaw@${targetVersion}). On npm 11.15 and earlier, omit --allow-scripts=openclaw.`,
          ].join("\n"),
      options,
    );
    this.name = "UpdateSchemaRefusalError";
    this.targetVersion = targetVersion;
    this.commands = commands;
  }
}
