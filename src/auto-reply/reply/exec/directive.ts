// Parses execution directives for approval, sandbox, and target settings.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  type ExecAsk,
  type ExecSecurity,
  type ExecTarget,
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizeExecTarget,
} from "../../../infra/exec-approvals-core.js";
import {
  removeDirectiveSpan,
  skipDirectiveArgPrefix,
  takeDirectiveToken,
} from "../directive-parsing.js";

/** Parsed `/exec` directive state used to override execution policy for one turn. */
type ExecDirectiveParse = {
  cleaned: string;
  hasDirective: boolean;
  execHost?: ExecTarget;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execNode?: string;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  rawExecNode?: string;
  hasExecOptions: boolean;
  invalidHost: boolean;
  invalidSecurity: boolean;
  invalidAsk: boolean;
  invalidNode: boolean;
};

/** Extracts and removes `/exec` options from message text. */
export function extractExecDirective(rawBody?: string): ExecDirectiveParse {
  const body = rawBody ?? "";
  const re = /(?<!\S)\/exec(?=$|\s|:)/i;
  const match = re.exec(body);
  const parsed: ExecDirectiveParse = {
    cleaned: body,
    hasDirective: match !== null,
    ...(match
      ? {
          execHost: undefined,
          execSecurity: undefined,
          execAsk: undefined,
          execNode: undefined,
          rawExecHost: undefined,
          rawExecSecurity: undefined,
          rawExecAsk: undefined,
          rawExecNode: undefined,
        }
      : {}),
    hasExecOptions: false,
    invalidHost: false,
    invalidSecurity: false,
    invalidAsk: false,
    invalidNode: false,
  };
  if (!match) {
    return parsed;
  }
  const start = match.index;
  const argsStart = start + "/exec".length;
  const raw = body.slice(argsStart);
  let i = skipDirectiveArgPrefix(raw);
  let consumed = i;
  while (i < raw.length) {
    const { token, nextIndex } = takeDirectiveToken(raw, i);
    i = nextIndex;
    if (!token) {
      break;
    }
    const eq = token.indexOf("=");
    const colon = token.indexOf(":");
    const separator = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (separator === -1) {
      break;
    }
    const key = normalizeOptionalLowercaseString(token.slice(0, separator));
    const value = token.slice(separator + 1).trim();
    if (key === "host") {
      parsed.rawExecHost = value;
      parsed.execHost = normalizeExecTarget(value) ?? undefined;
      parsed.invalidHost ||= !parsed.execHost;
    } else if (key === "security") {
      parsed.rawExecSecurity = value;
      parsed.execSecurity = normalizeExecSecurity(value) ?? undefined;
      parsed.invalidSecurity ||= !parsed.execSecurity;
    } else if (key === "ask") {
      parsed.rawExecAsk = value;
      parsed.execAsk = normalizeExecAsk(value) ?? undefined;
      parsed.invalidAsk ||= !parsed.execAsk;
    } else if (key === "node") {
      parsed.rawExecNode = value;
      if (!value) {
        parsed.invalidNode = true;
      } else {
        parsed.execNode = value;
      }
    } else {
      break;
    }
    parsed.hasExecOptions = true;
    consumed = i;
  }

  // Remove only consumed key/value options so remaining text still reaches the agent.
  parsed.cleaned = removeDirectiveSpan(body, start, argsStart + consumed);
  return parsed;
}
