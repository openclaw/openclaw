import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import JSON5 from "json5";
import { rejectConfigNonFiniteNumbers } from "../config/value-tree.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errors.js";

export type ConfigSetOptions = {
  strictJson?: boolean;
  /** @deprecated Use strictJson. */
  json?: boolean;
  dryRun?: boolean;
  allowExec?: boolean;
  merge?: boolean;
  replace?: boolean;
  refProvider?: string;
  refSource?: string;
  refId?: string;
  providerSource?: string;
  providerAllowlist?: string[];
  providerPath?: string;
  providerMode?: string;
  providerTimeoutMs?: string;
  providerMaxBytes?: string;
  providerCommand?: string;
  providerArg?: string[];
  providerNoOutputTimeoutMs?: string;
  providerMaxOutputBytes?: string;
  providerJsonOnly?: boolean;
  providerEnv?: string[];
  providerPassEnv?: string[];
  providerTrustedDir?: string[];
  batchJson?: string;
  batchFile?: string;
  expectCurrentAbsent?: boolean;
  expectCurrentJson?: string;
};

export type ConfigSetBatchEntry = {
  path: string;
  value?: unknown;
  ref?: unknown;
  provider?: unknown;
};

export type ConfigSetCurrentExpectation = { kind: "absent" } | { kind: "json"; value: unknown };

const CONFIG_MUTATION_FILE_MAX_BYTES = 8 * 1024 * 1024;

export function readConfigMutationFileSync(
  filePath: string,
  sourceLabel: "--batch-file" | "--file",
): string {
  // These explicit CLI file flags have historically followed user-provided
  // symlinks. Pin the opened descriptor, then bound the read without changing that contract.
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new Error(`${sourceLabel} not found: ${filePath}. Check the path and try again.`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(
        `${sourceLabel} must be a regular file: ${filePath}. Choose a JSON5 input file and try again.`,
      );
    }
    try {
      return readFileDescriptorBoundedSync(fd, CONFIG_MUTATION_FILE_MAX_BYTES).toString("utf8");
    } catch (error) {
      if (error instanceof RangeError) {
        throw new RangeError(
          `${sourceLabel} exceeds the 8 MiB supported maximum (${CONFIG_MUTATION_FILE_MAX_BYTES} bytes): ${filePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveConfigSetMode(
  opts: ConfigSetOptions,
): "value" | "json" | "ref_builder" | "provider_builder" | "batch" {
  const hasRef = Boolean(opts.refProvider || opts.refSource || opts.refId);
  const hasProvider = Boolean(
    opts.providerSource ||
    opts.providerAllowlist?.length ||
    opts.providerPath ||
    opts.providerMode ||
    opts.providerTimeoutMs ||
    opts.providerMaxBytes ||
    opts.providerCommand ||
    opts.providerArg?.length ||
    opts.providerNoOutputTimeoutMs ||
    opts.providerMaxOutputBytes ||
    opts.providerJsonOnly ||
    opts.providerEnv?.length ||
    opts.providerPassEnv?.length ||
    opts.providerTrustedDir?.length,
  );
  if (opts.batchJson !== undefined || opts.batchFile !== undefined) {
    if (hasRef || hasProvider) {
      throw new Error(
        "config set mode error: batch mode (--batch-json/--batch-file) cannot be combined with ref builder (--ref-*) or provider builder (--provider-*) flags.",
      );
    }
    return "batch";
  }
  if (hasRef && hasProvider) {
    throw new Error(
      "config set mode error: choose exactly one mode: ref builder (--ref-provider/--ref-source/--ref-id) or provider builder (--provider-*), not both.",
    );
  }
  return hasRef
    ? "ref_builder"
    : hasProvider
      ? "provider_builder"
      : opts.strictJson || opts.json
        ? "json"
        : "value";
}

export function parseConfigMutationJson5(raw: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${label}: ${String(err)}`, { cause: err });
  }
  rejectConfigNonFiniteNumbers(parsed);
  return parsed;
}

function parseBatchEntries(raw: string, sourceLabel: string): ConfigSetBatchEntry[] {
  const parsed = parseConfigMutationJson5(raw, sourceLabel);
  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceLabel} must be a JSON array.`);
  }
  if (parsed.length === 0) {
    throw new Error(`${sourceLabel} must contain at least one config update.`);
  }
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${sourceLabel}[${index}] must be an object.`);
    }
    const path = normalizeOptionalString(entry.path);
    if (!path) {
      throw new Error(`${sourceLabel}[${index}].path is required.`);
    }
    const hasValue = Object.hasOwn(entry, "value");
    const hasRef = Object.hasOwn(entry, "ref");
    const hasProvider = Object.hasOwn(entry, "provider");
    const modeCount = Number(hasValue) + Number(hasRef) + Number(hasProvider);
    if (modeCount !== 1) {
      throw new Error(
        `${sourceLabel}[${index}] must include exactly one of: value, ref, provider.`,
      );
    }
    return {
      path,
      ...(hasValue ? { value: entry.value } : {}),
      ...(hasRef ? { ref: entry.ref } : {}),
      ...(hasProvider ? { provider: entry.provider } : {}),
    };
  });
}

export function parseConfigSetCurrentExpectation(
  opts: ConfigSetOptions,
): ConfigSetCurrentExpectation | undefined {
  const expectAbsent = opts.expectCurrentAbsent === true;
  const hasExpectedJson = opts.expectCurrentJson !== undefined;
  if (!expectAbsent && !hasExpectedJson) {
    return undefined;
  }
  if (expectAbsent && hasExpectedJson) {
    throw new Error(
      "config set mode error: choose either --expect-current-absent or --expect-current-json, not both.",
    );
  }
  if (opts.dryRun) {
    throw new Error(
      "config set mode error: conditional expectations cannot be combined with --dry-run.",
    );
  }
  if (opts.batchJson !== undefined || opts.batchFile !== undefined) {
    throw new Error(
      "config set mode error: conditional expectations require one path operation and cannot be combined with batch mode.",
    );
  }
  if (expectAbsent) {
    return { kind: "absent" };
  }
  const expectedJson = opts.expectCurrentJson;
  if (expectedJson === undefined) {
    throw new Error("config set mode error: missing conditional expectation.");
  }
  let value: unknown;
  try {
    value = JSON.parse(expectedJson) as unknown;
    rejectConfigNonFiniteNumbers(value);
  } catch (error) {
    throw new Error("config set mode error: --expect-current-json must be valid JSON.", {
      cause: error,
    });
  }
  return { kind: "json", value };
}

export function parseBatchSource(opts: ConfigSetOptions): ConfigSetBatchEntry[] | null {
  // Batch mode is exclusive because each entry carries its own value/ref/provider mode.
  const batchJson = opts.batchJson;
  const hasInline = batchJson !== undefined;
  const hasFile = opts.batchFile !== undefined;
  if (!hasInline && !hasFile) {
    return null;
  }
  if (hasInline && hasFile) {
    throw new Error("Use either --batch-json or --batch-file, not both.");
  }
  if (hasInline) {
    return parseBatchEntries(batchJson, "--batch-json");
  }
  const pathname = readNonBlankString(opts.batchFile);
  if (!pathname) {
    throw new Error("--batch-file must not be empty.");
  }
  const raw = readConfigMutationFileSync(pathname, "--batch-file");
  return parseBatchEntries(raw, "--batch-file");
}
