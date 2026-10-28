import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { Option, type Command } from "commander";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_FILES,
  type SkillLibraryFile,
  type SkillsLibraryActivateResult,
  type SkillsLibraryListResult,
  type SkillsLibraryReadResult,
  type SkillsLibraryReceipt,
  type SkillsLibraryUploadResult,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { inheritOptionFromParent } from "./command-options.js";
import {
  addGatewayClientOptions,
  callGatewayFromCliWithTransport,
  type GatewayRpcOpts,
} from "./gateway-rpc.js";
import { collectOption } from "./program/helpers.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type LibraryOptions = GatewayRpcOpts & {
  slug?: string;
  expectedRevision?: string;
  revision?: string;
  clawhub?: boolean;
  version?: string;
  scope?: "mine" | "team" | "all";
  deleteFile?: string[];
  session?: string;
};

function receiptText(receipt: SkillsLibraryReceipt): string {
  return `${receipt.state}: ${sanitizeTerminalText(receipt.entry.slug)} (${receipt.target}, owner ${sanitizeTerminalText(receipt.entry.ownerLabel)})\nSkill ID: ${sanitizeTerminalText(receipt.entry.skillId)}\nRevision: ${sanitizeTerminalText(receipt.entry.revision)}\n${receipt.nextAction}\n`;
}

async function saveLocalLibrarySkill(input: string, slug: string, rpc: GatewayRpcOpts) {
  return callGatewayFromCliWithTransport<SkillsLibraryReceipt>("skills.library.save", rpc, {
    slug,
    expectedRevision: null,
    ...(await readLibraryInput(input)),
  });
}

export function registerSkillsLibraryCli(skills: Command): void {
  const library = addGatewayClientOptions(
    skills.command("library").description("Manage authenticated personal and team skill libraries"),
  )
    .option("--json", "Output as JSON", false)
    .addHelpText(
      "after",
      "\nCreate: openclaw skills library create ./my-skill --slug my-skill\nRead:   openclaw skills library read <skill-id> --json\nUpdate: openclaw skills library update <skill-id> ./SKILL.md --expected-revision <hash>\nPersonal libraries require a signed-in Gateway profile. Workspace installs remain under skills install.\n",
    );
  const leaf = (name: string, description: string) =>
    addGatewayClientOptions(library.command(name).description(description)).option(
      "--json",
      "Output as JSON",
      false,
    );
  const execute = <T>(
    command: Command,
    action: (opts: GatewayRpcOpts) => Promise<T>,
    format: (result: T) => string,
  ) =>
    runCommandWithRuntime(defaultRuntime, async () => {
      const commandOptions = command.opts<GatewayRpcOpts>();
      const value = <K extends keyof GatewayRpcOpts>(name: K): GatewayRpcOpts[K] =>
        inheritOptionFromParent<GatewayRpcOpts[K]>(command, name) ?? commandOptions[name];
      const opts: GatewayRpcOpts = {
        url: value("url"),
        port: value("port"),
        token: value("token"),
        password: value("password"),
        timeout: value("timeout"),
        expectFinal: value("expectFinal"),
        json: value("json"),
      };
      const result = await action(opts);
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        defaultRuntime.writeStdout(format(result));
      }
    });
  leaf("list", "List your own and visible shared skills")
    .addOption(
      new Option("--scope <scope>", "Library scope")
        .choices(["mine", "team", "all"])
        .default("all"),
    )
    .option("--session <key>", "Include this session’s selected revisions and attachable skills")
    .action((opts: LibraryOptions, command: Command) =>
      execute(
        command,
        (rpc) =>
          callGatewayFromCliWithTransport<SkillsLibraryListResult>("skills.library.list", rpc, {
            scope: opts.scope,
            ...(opts.session ? { sessionKey: opts.session } : {}),
          }),
        (result) =>
          [
            `Default target: ${result.defaultTarget}`,
            `New-session default selection limit: ${result.defaultSelectionLimit}`,
            ...(result.defaultSelectionNotice ? [result.defaultSelectionNotice] : []),
            ...(result.session
              ? [
                  `Session: ${result.session.sessionKey}`,
                  ...result.session.selections.map(
                    (selection) =>
                      `Selected: ${selection.skillId}  ${selection.slug}  owner=${selection.ownerLabel}  ${selection.revision}  ${selection.name}`,
                  ),
                  ...result.session.attachable.map(
                    (entry) =>
                      `Attachable: ${entry.skillId}  ${entry.slug}  owner=${entry.ownerLabel}`,
                  ),
                ]
              : []),
            ...result.entries.map(
              (entry) =>
                `${entry.skillId}  ${entry.slug}  owner=${entry.ownerLabel}  ${entry.enabled ? "enabled" : "disabled"}${entry.shared ? " shared" : ""}  ${entry.revision}`,
            ),
            ...(!result.profileId
              ? [
                  "Sign in with a durable Gateway profile to create personal skills. Administrators can use skills install for workspace skills.",
                ]
              : []),
            "",
          ]
            .map(sanitizeTerminalText)
            .join("\n"),
      ),
    );

  leaf("read", "Read the complete SKILL.md, supporting files, and revision history")
    .argument("<skill-id>", "Stable library skill ID")
    .option("--revision <hash>", "Read a retained revision")
    .option("--session <key>", "Read an exact session pin (requires --revision)")
    .action((skillId: string, opts: LibraryOptions, command: Command) =>
      execute(
        command,
        (rpc) => {
          if (opts.session && !opts.revision) {
            throw new Error("--session requires --revision to read an exact selected pin.");
          }
          return callGatewayFromCliWithTransport<SkillsLibraryReadResult>(
            "skills.library.read",
            rpc,
            {
              skillId,
              ...(opts.revision ? { revision: opts.revision } : {}),
              ...(opts.session ? { sessionKey: opts.session } : {}),
            },
          );
        },
        (result) =>
          [
            `${sanitizeTerminalText(result.entry.slug)} (${sanitizeTerminalText(result.entry.ownerLabel)})`,
            `Skill ID: ${sanitizeTerminalText(result.entry.skillId)}`,
            `Revision: ${sanitizeTerminalText(result.entry.revision)}`,
            `Command: ${sanitizeTerminalText(result.entry.name)}`,
            "--- SKILL.md ---",
            result.content,
            ...result.files.flatMap((file) => [
              `--- ${sanitizeTerminalText(file.path)} (${file.encoding ?? "utf8"}${file.executable ? ", executable" : ""}) ---`,
              file.content,
            ]),
            "Retained revisions:",
            ...result.revisions.map(
              (revision) => `${revision.revision}  ${new Date(revision.createdAt).toISOString()}`,
            ),
            "",
          ].join("\n"),
      ),
    );

  leaf("create", "Save a private skill from SKILL.md or a complete local directory")
    .argument("<path>", "Local SKILL.md or skill directory")
    .requiredOption("--slug <slug>", "Library name (lowercase letters, digits, hyphens)")
    .action((input: string, opts: LibraryOptions & { slug: string }, command: Command) =>
      execute(command, (rpc) => saveLocalLibrarySkill(input, opts.slug, rpc), receiptText),
    );

  leaf(
    "update",
    "Save a revision; a single SKILL.md preserves supporting files, a directory replaces the bundle",
  )
    .argument("<skill-id>", "Stable library skill ID")
    .argument("<path>", "Local SKILL.md or complete replacement directory")
    .requiredOption(
      "--expected-revision <hash>",
      "Current revision from library read; conflicts never overwrite",
    )
    .option("--slug <slug>", "Change the library name")
    .option(
      "--delete-file <path>",
      "Explicitly remove a supporting file (repeatable)",
      collectOption,
    )
    .action((skillId: string, input: string, opts: LibraryOptions, command: Command) =>
      execute(
        command,
        async (rpc) => {
          const current = await callGatewayFromCliWithTransport<SkillsLibraryReadResult>(
            "skills.library.read",
            rpc,
            { skillId },
          );
          const bundle = await readLibraryInput(input);
          const files = bundle.files ?? current.files;
          for (const deleted of opts.deleteFile ?? []) {
            if (!files.some((file) => file.path === deleted)) {
              throw new Error(`Supporting file not found: ${deleted}`);
            }
          }
          return callGatewayFromCliWithTransport<SkillsLibraryReceipt>("skills.library.save", rpc, {
            skillId,
            expectedRevision: opts.expectedRevision,
            slug: opts.slug ?? current.entry.slug,
            content: bundle.content,
            files: files.filter((file) => !opts.deleteFile?.includes(file.path)),
          });
        },
        receiptText,
      ),
    );

  leaf("import", "Privately import a local bundle, ZIP, or ClawHub skill")
    .argument("<source>", "Local path or ClawHub reference with --clawhub")
    .requiredOption("--slug <slug>", "Destination name in your personal library")
    .option("--clawhub", "Read source from ClawHub; never publishes your files", false)
    .option("--version <version>", "ClawHub version")
    .action((source: string, opts: LibraryOptions & { slug: string }, command: Command) =>
      execute(
        command,
        async (rpc) => {
          if (opts.version && !opts.clawhub) {
            throw new Error("--version requires --clawhub.");
          }
          if (opts.clawhub) {
            return callGatewayFromCliWithTransport<SkillsLibraryReceipt>(
              "skills.library.import",
              rpc,
              {
                slug: opts.slug,
                source: {
                  kind: "clawhub",
                  slug: source,
                  ...(opts.version ? { version: opts.version } : {}),
                },
              },
            );
          }
          if (source.toLowerCase().endsWith(".zip") && !(await fs.lstat(source)).isDirectory()) {
            const { buffer: bytes } = await readRegularFile({
              filePath: source,
              maxBytes: SKILL_LIBRARY_MAX_BUNDLE_BYTES,
            });
            if (bytes.length === 0) {
              throw new Error("ZIP import requires a regular file between 1 byte and 8 MiB.");
            }
            const call = (params: unknown) =>
              callGatewayFromCliWithTransport<SkillsLibraryUploadResult>(
                "skills.library.upload",
                rpc,
                params,
              );
            const begin = await call({
              action: "begin",
              slug: opts.slug,
              sizeBytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
            if (!("uploadId" in begin)) {
              throw new Error("Gateway did not open the upload. Retry the import.");
            }
            let offset = begin.offset;
            while (offset < bytes.length) {
              const end = Math.min(offset + begin.maxChunkBytes, bytes.length);
              const chunk = await call({
                action: "chunk",
                uploadId: begin.uploadId,
                offset,
                data: bytes.subarray(offset, end).toString("base64"),
              });
              if (!("offset" in chunk) || chunk.offset !== end) {
                throw new Error(
                  "Upload acknowledgement did not match the chunk. Retry the import.",
                );
              }
              offset = chunk.offset;
            }
            const result = await call({ action: "commit", uploadId: begin.uploadId });
            if (!("state" in result)) {
              throw new Error(
                "Gateway did not confirm publication. List your library before retrying.",
              );
            }
            return result;
          }
          return saveLocalLibrarySkill(source, opts.slug, rpc);
        },
        receiptText,
      ),
    );

  for (const action of [
    "remove",
    "share",
    "unshare",
    "transfer",
    "enable",
    "disable",
    "rollback",
  ] as const) {
    const command = leaf(
      action,
      action === "transfer"
        ? "Transfer ownership to the team (administrator only)"
        : `${action.charAt(0).toUpperCase()}${action.slice(1)} a managed skill`,
    )
      .argument("<skill-id>", "Stable library skill ID")
      .requiredOption("--expected-revision <hash>", "Current revision from library read");
    if (action === "rollback") {
      command.requiredOption("--revision <hash>", "Retained revision to restore");
    }
    command.action(
      (skillId: string, opts: LibraryOptions & { expectedRevision: string }, cmd: Command) =>
        execute(
          cmd,
          (rpc) =>
            callGatewayFromCliWithTransport<SkillsLibraryReceipt>("skills.library.mutate", rpc, {
              skillId,
              action,
              expectedRevision: opts.expectedRevision,
              ...(opts.revision ? { revision: opts.revision } : {}),
            }),
          receiptText,
        ),
    );
  }
  for (const action of ["attach", "detach", "refresh"] as const) {
    const command = leaf(
      action,
      `${action.charAt(0).toUpperCase()}${action.slice(1)} managed selections explicitly for the next session turn`,
    ).requiredOption("--session <key>", "Exact target session key");
    if (action === "refresh") {
      command.option("--skill-id <id>", "Refresh only this selected skill; omit to refresh all");
    } else {
      command.requiredOption("--skill-id <id>", "Stable library skill ID");
    }
    if (action === "attach") {
      command.option("--revision <hash>", "Retained revision to select");
    }
    command.action((opts: LibraryOptions & { session: string; skillId?: string }, cmd: Command) =>
      execute(
        cmd,
        (rpc) =>
          callGatewayFromCliWithTransport<SkillsLibraryActivateResult>(
            "skills.library.activate",
            rpc,
            {
              action,
              sessionKey: opts.session,
              ...(opts.skillId ? { skillId: opts.skillId } : {}),
              ...(opts.revision ? { revision: opts.revision } : {}),
            },
          ),
        (result) =>
          `Queued for next turn: ${sanitizeTerminalText(result.sessionKey)}\n${result.selections.map((selection) => `${sanitizeTerminalText(selection.skillId)}  ${sanitizeTerminalText(selection.name)}  ${sanitizeTerminalText(selection.revision)}`).join("\n")}\n`,
      ),
    );
  }
  applyParentDefaultHelpAction(library);
}

async function readLibraryInput(input: string): Promise<{
  content: string;
  files?: SkillLibraryFile[];
}> {
  const root = path.resolve(input);
  const info = await fs.lstat(root);
  let total = 0;
  let count = 0;
  const files: SkillLibraryFile[] = [];
  let content: string | undefined;
  const read = async (file: string, relative: string) => {
    count += 1;
    if (count > SKILL_LIBRARY_MAX_FILES) {
      throw new Error("Skill bundle exceeds the 1 MiB/file, 8 MiB/bundle, or 256-file limit.");
    }
    const { buffer: bytes, stat } = await readRegularFile({
      filePath: file,
      maxBytes: Math.min(SKILL_LIBRARY_MAX_FILE_BYTES, SKILL_LIBRARY_MAX_BUNDLE_BYTES - total),
    });
    total += bytes.length;
    if (relative === "SKILL.md") {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return;
    }
    // Base64 round-trips every supporting file, including binary assets and CRLF text.
    files.push({
      path: relative,
      content: bytes.toString("base64"),
      encoding: "base64",
      executable: (stat.mode & 0o111) !== 0,
    });
  };
  const walk = async (directory: string, prefix = "") => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
      } else {
        await read(path.join(directory, entry.name), relative);
      }
    }
  };
  if (info.isDirectory()) {
    await walk(root);
  } else {
    await read(root, "SKILL.md");
  }
  if (content === undefined) {
    throw new Error("The bundle must contain SKILL.md at its root.");
  }
  return { content, ...(info.isDirectory() ? { files } : {}) };
}
