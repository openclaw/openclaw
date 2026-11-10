import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../../logging/logger.js";
import {
  SessionDeliveryGenerationUnavailableError,
  isSessionDeliveryGenerationRevokedError,
  isSessionDeliveryGenerationUnavailableError,
} from "./session-delivery-generation-errors.js";

const branches = [
  "active-closed",
  "active-invalidated",
  "current-fallback",
  "entry-missing",
  "entry-tentative",
  "initial-identity",
  "initial-absence",
  "native-handle",
  "native-pending",
  "native-revision",
  "native-policy",
  "effect-native",
  "effect-identity",
  "effect-policy",
  "admission-missing",
  "source-admission",
  "delivery-mutation",
  "effect-source",
  "effect-entry",
  "creation-binding",
  "creation-fallback",
  "prepare-fallback",
] as const satisfies readonly string[];
type BranchTag = (typeof branches)[number];
type FlipKind =
  | "row-invalidated"
  | "schema-invalidated"
  | "resource-revoked"
  | "released"
  | "check-detected"
  | "none";
type NotCapturedReason =
  | "not-captured-kind"
  | "no-flip"
  | "root-unresolved"
  | "no-accepted-frames"
  | "capture-failed"
  | "budget";
type Projection =
  | { captured: true; frames: string[]; async: boolean }
  | { captured: false; notCapturedReason: NotCapturedReason };
type Flip = Projection & { kind: FlipKind };
type State = { active: boolean; invalidated: boolean; revoked: boolean };

const modulePath = fileURLToPath(import.meta.url);
const packageRoot = (() => {
  for (let dir = path.dirname(modulePath); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir) === "src" || path.basename(dir) === "dist") {
      return path.dirname(dir);
    }
  }
  return undefined;
})();

/** Positions are an observed flip call chain, not identities of the mutation producer. */
export function projectLeaseDiagnosticFrames(stack: string, root: string | undefined): Projection {
  if (!root) {
    return { captured: false, notCapturedReason: "root-unresolved" };
  }
  const frames: string[] = [];
  let async = false;
  for (const line of stack.split("\n")) {
    if (/[\x00-\x1f\x7f]|\b(?:eval|vm)\b|<anonymous>|node:/.test(line)) {
      continue;
    }
    const match = /(?:\(|^\s*at (?:async )?)([^()]+):(\d+):(\d+)\)?$/.exec(line);
    if (!match) {
      continue;
    }
    let filename = match[1]!;
    try {
      const decoded = decodeURIComponent(filename);
      if (/[?#\x00-\x20\x7f]/.test(decoded) || decoded.split(/[\\/]/).includes("..")) {
        continue;
      }
      filename = filename.startsWith("file:") ? fileURLToPath(filename) : filename;
    } catch {
      continue;
    }
    if (!path.isAbsolute(filename) || filename === modulePath) {
      continue;
    }
    const relative = path.relative(root, filename).split(path.sep).join("/");
    if (
      !/^(src|dist)\/[^\s?#]+\.(ts|js|mjs|cjs)$/.test(relative) ||
      relative.split("/").includes("node_modules")
    ) {
      continue;
    }
    frames.push(relative + ":" + match[2] + ":" + match[3]);
    async ||= /^\s*at async\b/.test(line);
    if (frames.length === 4) {
      break;
    }
  }
  return frames.length
    ? { captured: true, frames, async }
    : { captured: false, notCapturedReason: "no-accepted-frames" };
}

/** File leases only; pre-lease validation, callback reasons and memory leases are not refusals here. */
export function createLeaseDiagnostics(readState: () => State) {
  let firstFlip: Flip | undefined;
  let emitted = false;
  function flip(kind: Exclude<FlipKind, "none">) {
    if (firstFlip) {
      return;
    }
    firstFlip = { kind, captured: false, notCapturedReason: "not-captured-kind" };
    if (
      kind !== "row-invalidated" &&
      kind !== "schema-invalidated" &&
      kind !== "resource-revoked"
    ) {
      return;
    }
    firstFlip = { kind, captured: false, notCapturedReason: "capture-failed" };
    try {
      const holder: { stack?: string } = {};
      Error.captureStackTrace(holder, flip);
      const stack = holder.stack;
      if (typeof stack === "string") {
        firstFlip = { kind, ...projectLeaseDiagnosticFrames(stack, packageRoot) };
      }
    } catch {
      /* Diagnostic capture cannot change lease settlement. */
    }
  }
  const diagnostics = {
    flip,
    unavailable(
      branch: BranchTag,
      error: unknown = new SessionDeliveryGenerationUnavailableError(),
    ) {
      if (!emitted) {
        emitted = true;
        try {
          const { active, invalidated, revoked } = readState();
          const observedFlip: Flip = firstFlip ?? {
            kind: "none",
            captured: false,
            notCapturedReason: "no-flip",
          };
          const record = {
            event: "lease-unavailable-first-refusal",
            branch,
            state: { active, invalidated, revoked },
            flip: observedFlip,
            producer: "unknown",
            relation: "observed-invalidation-call-chain",
          };
          if (Buffer.byteLength(JSON.stringify(record)) > 1024) {
            record.flip = { kind: record.flip.kind, captured: false, notCapturedReason: "budget" };
          }
          getLogger().warn(record);
        } catch {
          /* Emission is best effort and never replaces the original error. */
        }
      }
      return error;
    },
    fallback(branch: "current-fallback" | "prepare-fallback", error: unknown) {
      const failure =
        isSessionDeliveryGenerationRevokedError(error) ||
        isSessionDeliveryGenerationUnavailableError(error)
          ? error
          : new SessionDeliveryGenerationUnavailableError({ cause: error });
      if (!isSessionDeliveryGenerationRevokedError(failure)) {
        diagnostics.unavailable(branch, failure);
      }
      return failure;
    },
  };
  return diagnostics;
}
