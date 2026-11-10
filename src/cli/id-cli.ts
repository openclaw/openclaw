// `openclaw id`: OpenClaw ID remote access of the Gateway on this machine. `rebind`
// moves the claw to new machine keys with its recovery kit; the Gateway accepts it only
// from a direct-loopback client, never over the tunnel.
import { setTimeout as sleep } from "node:timers/promises";
import { password } from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import type { Command } from "commander";
import {
  signRebind,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type RebindPreparation,
  type RebindSignRefusal,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";
import { describeRebind, displayKey } from "./id-cli-rebind.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";
import { promptYesNo } from "./prompt.js";

type IdCliOpts = GatewayRpcOpts & { json?: boolean };
type RebindOpts = IdCliOpts & {
  kitStdin?: boolean;
  yes?: boolean;
  cancel?: boolean;
  code?: string;
  bindingSeq?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
// How long `rebind` waits to see Discovery accept the new keys before it reports progress.
const PUBLICATION_WAIT_MS = 30_000;
const KIT_MAX_BYTES = 1024;

function addIdGatewayOptions(command: Command) {
  return command
    .option("--url <url>", "Gateway WebSocket URL (must be this machine's Gateway)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", String(DEFAULT_TIMEOUT_MS))
    .option("--json", "Output JSON", false);
}

const authority = (opts: IdCliOpts, params: Record<string, unknown>) =>
  callGatewayFromCli("openclawId.authority", opts, params, { scopes: ["operator.admin"] });

type KeysStatus = {
  status?: { state?: string; key?: string; reason?: string };
  link?: { linked?: boolean; hostname?: string };
};
type PeopleLink = {
  binding?: {
    bindingSeq: number;
    kSrv: IrohEndpointKey;
    kGw: Ed25519PublicKey;
    publishedBindingSeq: number;
  };
  publication?: {
    state?: string;
    code?: string;
    superseded?: {
      bindingSeq: number;
      publishedBindingSeq: number;
      kSrv: IrohEndpointKey;
      kGw: Ed25519PublicKey;
    };
  };
};

async function readPeopleLink(opts: IdCliOpts): Promise<PeopleLink | undefined> {
  const raw = await callGatewayFromCli(
    "openclawId.people",
    opts,
    {},
    { scopes: ["operator.admin"] },
  );
  // SAFETY: openclawId.people answers { link } with the owner link view (owner-link-view.ts).
  const result = raw as { link?: PeopleLink };
  return result.link;
}

/** One line for the remote-access state, with the fix for refused keys. */
export function describeKeysState(status: KeysStatus["status"]): string {
  if (status?.state !== "keys_refused") {
    return `Remote access: ${status?.state ?? "unknown"}`;
  }
  return status.reason === "key_mismatch"
    ? "Remote access is off: the connection key on this computer isn't the one your devices trust. Restore the original key file, or move the claw to new keys with your recovery kit: openclaw id rebind"
    : "Remote access is off: this claw's connection keys are missing from this computer, so your devices can't reach it. Move it to new keys with your recovery kit: openclaw id rebind";
}

function parseBindingSeq(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("--binding-seq must be a positive whole number.");
  }
  return seq;
}

// The owner account's one-time link code: it reads Discovery's binding and publishes the move.
async function readLinkCode(opts: RebindOpts): Promise<string> {
  if (opts.code?.trim()) {
    return opts.code.trim();
  }
  if (opts.kitStdin) {
    throw new Error("--kit-stdin needs --code <link-code> from your OpenClaw ID account.");
  }
  const code = await password({
    message: "Link code from your OpenClaw ID account (Add a claw page, claws.<domain>/link)",
    mask: "",
  });
  if (typeof code === "symbol" || !code.trim()) {
    throw new Error("Cancelled.");
  }
  return code.trim();
}

/** Why nothing was signed, and what to do. */
export function describeSignRefusal(refusal: RebindSignRefusal, hostname: string): string {
  switch (refusal.code) {
    case "wrong_kit":
      return `This recovery kit is for another claw (${refusal.kitRoot}). Use the kit made for ${sanitizeTerminalText(hostname)}.`;
    case "published_unverifiable":
      return `${refusal.detail}. Nothing was signed. If you trust this computer's copy, pass --binding-seq with a number above every binding you know of.`;
    case "published_unavailable":
      return `Couldn't read the binding Discovery publishes (${sanitizeTerminalText(refusal.detail)}). Try again, or pass --binding-seq ${refusal.atLeast} or higher.`;
    case "binding_seq_too_low":
      return `--binding-seq must be at least ${refusal.atLeast}.`;
    default:
      return refusal satisfies never;
  }
}

async function readKit(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const bytes = await readByteStreamWithLimit(process.stdin, { maxBytes: KIT_MAX_BYTES });
    return Buffer.from(bytes).toString("utf8");
  }
  const kit = await password({ message: "Recovery kit (OCK1-…)", mask: "" });
  if (typeof kit === "symbol") {
    throw new Error("Cancelled.");
  }
  return kit;
}

function write(opts: IdCliOpts, json: unknown, text: string) {
  process.stdout.write(opts.json ? `${JSON.stringify(json, null, 2)}\n` : `${text}\n`);
}

async function runStatus(opts: IdCliOpts) {
  const raw = await callGatewayFromCli(
    "openclawId.status",
    opts,
    {},
    { scopes: ["operator.read"] },
  );
  // SAFETY: openclawId.status answers the status shape KeysStatus reads a subset of.
  const status = raw as KeysStatus;
  const link = status.link?.linked ? await readPeopleLink(opts) : undefined;
  const lines = [describeKeysState(status.status)];
  if (status.link?.hostname) {
    lines.push(`Claw: ${sanitizeTerminalText(status.link.hostname)}`);
  }
  if (link?.binding) {
    lines.push(
      `Binding: ${link.binding.bindingSeq} (Discovery has ${link.binding.publishedBindingSeq})`,
      `Endpoint key: ${await displayKey(link.binding.kSrv)}`,
      `Gateway key: ${await displayKey(link.binding.kGw)}`,
    );
  }
  const superseded = link?.publication?.superseded;
  if (link?.publication?.code === "binding_superseded" && superseded) {
    lines.push(
      `Publication: Discovery lists newer keys for this claw (binding ${superseded.publishedBindingSeq}; this computer has ${superseded.bindingSeq}) that this computer doesn't have.`,
      `  Published endpoint key: ${await displayKey(superseded.kSrv)}`,
      `  Published Gateway key: ${await displayKey(superseded.kGw)}`,
      "  If you restored this computer from a backup, run openclaw id rebind.",
      "  If you didn't, someone may have your recovery kit: run openclaw id rebind now. If that fails because your account is also compromised, relink this claw as a new claw from this computer.",
    );
  } else if (link?.publication?.code === "needs_link_code") {
    lines.push(
      "Publication: the new keys wait for a link code from your OpenClaw ID account: openclaw id publish --code <link-code>",
    );
  } else if (link?.publication?.state) {
    lines.push(
      `Publication: ${link.publication.state}${link.publication.code ? ` (${link.publication.code})` : ""}`,
    );
  }
  write(opts, { ...status, people: link ?? null }, lines.join("\n"));
}

async function waitForPublication(opts: IdCliOpts, bindingSeq: number) {
  const deadline = Date.now() + PUBLICATION_WAIT_MS;
  while (Date.now() < deadline) {
    const link = await readPeopleLink(opts);
    if ((link?.binding?.publishedBindingSeq ?? 0) >= bindingSeq) {
      return true;
    }
    await sleep(1_000);
  }
  return false;
}

async function runRebind(opts: RebindOpts) {
  if (opts.cancel) {
    await authority(opts, { action: "rebind_cancel" });
    write(opts, { cancelled: true }, "Cancelled: the keys staged for the move were deleted.");
    return;
  }
  if (opts.yes && !opts.kitStdin) {
    throw new Error("--yes needs --kit-stdin: type the recovery kit at the prompt otherwise.");
  }
  const bindingSeq = parseBindingSeq(opts.bindingSeq);
  const code = await readLinkCode(opts);
  // SAFETY: rebind_prepare answers with the preparation shape (id-cli-rebind.ts).
  const prep = (await authority(opts, { action: "rebind_prepare", code })) as RebindPreparation;
  const signed = await signRebind(prep, await readKit(opts.kitStdin === true), { bindingSeq });
  if (!signed.ok) {
    throw new Error(describeSignRefusal(signed, prep.hostname));
  }
  if (!opts.yes) {
    process.stdout.write(`${await describeRebind(prep, signed.binding)}\n`);
    if (!(await promptYesNo("Move to new keys?"))) {
      write(
        opts,
        { moved: false },
        "Not moved. The staged keys stay for the next try (openclaw id rebind --cancel deletes them).",
      );
      return;
    }
  }
  const raw = await authority(opts, { action: "rebind_commit", binding: signed.binding, code });
  // SAFETY: rebind_commit answers { ok, bindingSeq }.
  const committed = raw as { bindingSeq: number };
  let published: boolean;
  try {
    published = await waitForPublication(opts, committed.bindingSeq);
  } catch (error) {
    const reason = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
    write(
      opts,
      {
        moved: true,
        bindingSeq: committed.bindingSeq,
        published: null,
        publicationError: reason,
        nextStep: "openclaw id status",
      },
      [
        "Moved to new keys (committed).",
        `Publication check failed: ${reason}`,
        "Run openclaw id status to check publication. Do not repeat rebind: it rotates keys again.",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  write(
    opts,
    { moved: true, bindingSeq: committed.bindingSeq, published },
    [
      "Moved to new keys. Devices reconnect by themselves.",
      published
        ? "Discovery has the new keys."
        : "Discovery doesn't have the new keys yet; the Gateway keeps publishing them (openclaw id status).",
      "If you did this because you think a key leaked, also check Your devices and People.",
    ].join("\n"),
  );
}

export function registerIdCli(program: Command) {
  const id = program
    .command("id")
    .description("OpenClaw ID remote access of this machine's Gateway");

  addIdGatewayOptions(
    id.command("status").description("Show remote access, the claw's keys and publication"),
  ).action(async (opts: IdCliOpts) => await runStatus(opts));

  addIdGatewayOptions(
    id
      .command("rebind")
      .description("Move this claw to new keys with its recovery kit (on this machine only)")
      .option("--kit-stdin", "Read the recovery kit from stdin instead of a hidden prompt", false)
      .option("--code <link-code>", "One-time link code from your OpenClaw ID account")
      .option(
        "--binding-seq <n>",
        "Binding number to sign when Discovery can't be read (above every known binding)",
      )
      .option("--yes", "Skip the confirmation (needs --kit-stdin)", false)
      .option("--cancel", "Delete keys staged by an unfinished move", false),
  ).action(async (opts: RebindOpts) => await runRebind(opts));

  addIdGatewayOptions(
    id
      .command("publish")
      .description("Publish this claw to Discovery now")
      .option("--code <code>", "One-time link code from your OpenClaw ID account"),
  ).action(async (opts: IdCliOpts & { code?: string }) => {
    const result = await authority(opts, {
      action: "publish",
      ...(opts.code ? { enrollmentCode: opts.code } : {}),
    });
    write(opts, result, JSON.stringify(result));
  });

  applyParentDefaultHelpAction(id);
}
