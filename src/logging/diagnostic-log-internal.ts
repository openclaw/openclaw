// Internal diagnostic log markers and source capture helpers.

export type DiagnosticLogSource = {
  filePath?: string;
  line?: number;
  functionName?: string;
};

export type DiagnosticLogSourceCaptureOptions = {
  ignoredMethods?: readonly string[];
  ignoredPathSuffixes?: readonly string[];
};

export type DiagnosticLogSemantics = {
  event?: string;
  category?: string;
  outcome?: "failure" | "success" | "warning";
  reason?: string;
};

const DIAGNOSTIC_LOG_SEMANTICS_FIELD = "__openclawDiagnosticLogSemantics";
const DIAGNOSTIC_LOG_SOURCE_FIELD = "__openclawDiagnosticLogSource";
const DIAGNOSTIC_LOG_SEMANTICS_TOKEN = `${Date.now()}:${Math.random()}`;

type AttachedDiagnosticLogSemantics = {
  fields: DiagnosticLogSemantics;
  proof: string;
};

type AttachedDiagnosticLogSource = {
  fields: DiagnosticLogSource;
  proof: string;
};

export function readAttachedDiagnosticLogSemantics(
  source: Record<string, unknown> | undefined,
): DiagnosticLogSemantics | undefined {
  const candidate = source?.[DIAGNOSTIC_LOG_SEMANTICS_FIELD] as
    | AttachedDiagnosticLogSemantics
    | undefined;
  return candidate?.proof === DIAGNOSTIC_LOG_SEMANTICS_TOKEN ? candidate.fields : undefined;
}

export function readAttachedDiagnosticLogSource(
  source: Record<string, unknown> | undefined,
): DiagnosticLogSource | undefined {
  const candidate = source?.[DIAGNOSTIC_LOG_SOURCE_FIELD] as
    | AttachedDiagnosticLogSource
    | undefined;
  return candidate?.proof === DIAGNOSTIC_LOG_SEMANTICS_TOKEN ? candidate.fields : undefined;
}

export function attachDiagnosticLogSemantics<T extends Record<string, unknown>>(
  source: T,
  semantics: DiagnosticLogSemantics,
): T {
  Object.defineProperty(source, DIAGNOSTIC_LOG_SEMANTICS_FIELD, {
    configurable: true,
    enumerable: true,
    value: {
      fields: semantics,
      proof: DIAGNOSTIC_LOG_SEMANTICS_TOKEN,
    },
  });
  return source;
}

export function hasDiagnosticLogSemantics(source: Record<string, unknown> | undefined): boolean {
  return Boolean(readAttachedDiagnosticLogSemantics(source));
}

export function attachDiagnosticLogSource<T extends Record<string, unknown>>(
  source: T,
  diagnosticSource: DiagnosticLogSource,
): T {
  Object.defineProperty(source, DIAGNOSTIC_LOG_SOURCE_FIELD, {
    configurable: true,
    enumerable: true,
    value: {
      fields: diagnosticSource,
      proof: DIAGNOSTIC_LOG_SEMANTICS_TOKEN,
    },
  });
  return source;
}

function normalizeStackFilePath(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return value;
    }
  }
  return value;
}

function parseDiagnosticStackFrame(
  rawLine: string,
  options: DiagnosticLogSourceCaptureOptions = {},
): DiagnosticLogSource | undefined {
  const line = rawLine.trim().replace(/^at\s+/u, "");
  const match = /^(?:(?<method>.*?)\s+\()?(?<filePath>.+):(?<line>\d+):(?<column>\d+)\)?$/u.exec(
    line,
  );
  const filePath = match?.groups?.filePath;
  const lineNumber = Number(match?.groups?.line);
  if (!filePath || !Number.isFinite(lineNumber)) {
    return undefined;
  }
  const normalizedPath = normalizeStackFilePath(filePath);
  const rawMethod = match?.groups?.method?.trim();
  const method = rawMethod?.replace(/^(?:Object|Module)\./u, "");
  const ignoredMethods = new Set([
    "captureDiagnosticLogSource",
    "parseDiagnosticStackFrame",
    ...(options.ignoredMethods ?? []),
  ]);
  if (
    normalizedPath.startsWith("node:") ||
    normalizedPath.includes("/node:") ||
    (method ? ignoredMethods.has(method) : false) ||
    options.ignoredPathSuffixes?.some((suffix) => normalizedPath.endsWith(suffix))
  ) {
    return undefined;
  }
  const functionName =
    method && !method.startsWith("file://") && method !== "async" ? method : undefined;
  return {
    filePath: normalizedPath,
    line: lineNumber,
    ...(functionName ? { functionName } : {}),
  };
}

export function captureDiagnosticLogSource(
  options: DiagnosticLogSourceCaptureOptions = {},
): DiagnosticLogSource | undefined {
  let stack: unknown;
  try {
    stack = new Error().stack;
  } catch {
    return undefined;
  }
  if (typeof stack !== "string" || !stack) {
    return undefined;
  }
  for (const line of stack.split("\n").slice(1)) {
    const source = parseDiagnosticStackFrame(line, options);
    if (source) {
      return source;
    }
  }
  return undefined;
}

export function splitDiagnosticLogSemanticFields(source: Record<string, unknown> | undefined): {
  attributes?: Record<string, unknown>;
  semantics?: DiagnosticLogSemantics;
} {
  if (!source) {
    return {};
  }
  const attributes: Record<string, unknown> = {};
  const semantics = readAttachedDiagnosticLogSemantics(source);
  for (const [key, value] of Object.entries(source)) {
    if (key !== DIAGNOSTIC_LOG_SEMANTICS_FIELD && key !== DIAGNOSTIC_LOG_SOURCE_FIELD) {
      attributes[key] = value;
    }
  }
  return {
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(semantics ? { semantics } : {}),
  };
}

export function stripAttachedDiagnosticLogFields<T extends Record<string, unknown>>(source: T): T {
  const copy = { ...source };
  delete copy[DIAGNOSTIC_LOG_SEMANTICS_FIELD];
  delete copy[DIAGNOSTIC_LOG_SOURCE_FIELD];
  return copy;
}
