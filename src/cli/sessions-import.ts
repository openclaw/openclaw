import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  SessionCatalogHost,
  SessionCatalogLocator,
  SessionsCatalogImportParams,
  SessionsCatalogImportResult,
  SessionsCatalogListParams,
  SessionsCatalogListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { ExpectedCliError, formatCliJsonFailure } from "./failure-output.js";
import { callSessionTargetGateway, type SessionTargetGateway } from "./session-target.js";

export type SessionsImportOptions = SessionTargetGateway & {
  catalogId?: string;
  threadId?: string;
  all?: boolean;
  catalog?: string;
  host?: string;
  sourceHome?: string;
  agent?: string;
  limit?: string;
  timeout?: string;
  dryRun?: boolean;
  json?: boolean;
};

type ImportResult = Partial<SessionCatalogLocator> &
  (
    | ({ ok: true; status: "imported" | "updated" | "unchanged" } & SessionsCatalogImportResult)
    | { ok: true; status: "would_import" }
    | { ok: false; status: "failed"; error: string }
  );

function invalidOptions(message: string): never {
  throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}

function optionalValue(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || invalidOptions(`${flag} must not be blank.`);
}

function printResult(result: ImportResult, runtime: RuntimeEnv): void {
  const source = sanitizeTerminalText(
    [result.catalogId, result.hostId, result.sourceHomeId, result.threadId]
      .filter(Boolean)
      .join("/"),
  );
  if (!result.ok) {
    runtime.error(`Failed ${source || "catalog listing"}: ${sanitizeTerminalText(result.error)}`);
  } else if (result.status === "would_import") {
    runtime.log(`[dry-run] Would import ${source}`);
  } else {
    const verb = { imported: "Imported", updated: "Updated", unchanged: "Unchanged" }[
      result.status
    ];
    runtime.log(
      `${verb} ${source} -> ${sanitizeTerminalText(result.sessionKey)}: ${result.importedItems} new / ${result.totalItems} source items${result.complete ? "" : " (incomplete: oldest history exceeded the import bound)"}`,
    );
  }
}

export async function sessionsImportCommand(
  opts: SessionsImportOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const agentId = optionalValue(opts.agent, "--agent");
  const hostId = optionalValue(opts.host, "--host");
  const sourceHomeId = optionalValue(opts.sourceHome, "--source-home");
  const catalogId = optionalValue(opts.catalogId, "<catalogId>");
  const threadId = optionalValue(opts.threadId, "<threadId>");
  const catalog = optionalValue(opts.catalog, "--catalog");
  const limit = parseStrictPositiveInteger(opts.limit);
  const timeoutMs = parseStrictPositiveInteger(opts.timeout);
  if (opts.limit !== undefined && limit === undefined) {
    invalidOptions("--limit must be a positive integer.");
  }
  if (opts.timeout !== undefined && timeoutMs === undefined) {
    invalidOptions("--timeout must be a positive integer (milliseconds).");
  }
  if (opts.all ? catalogId !== undefined || threadId !== undefined : !catalogId || !threadId) {
    invalidOptions("Pass either <catalogId> <threadId> or --all.");
  }
  if (opts.all && sourceHomeId !== undefined) {
    invalidOptions("--source-home selects a single transcript and cannot be combined with --all.");
  }
  if (!opts.all && (catalog !== undefined || limit !== undefined)) {
    invalidOptions("--catalog and --limit require --all.");
  }
  const gateway: SessionTargetGateway = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
  };
  const results: ImportResult[] = [];
  const record = (result: ImportResult) => {
    results.push(result);
    if (!opts.json) {
      printResult(result, runtime);
    }
  };
  const seen = new Set<string>();
  const importOne = async (locator: SessionsCatalogImportParams) => {
    const identity = JSON.stringify([
      locator.catalogId,
      locator.hostId,
      locator.sourceHomeId ?? null,
      locator.threadId,
    ]);
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    if (opts.dryRun) {
      record({ ...locator, ok: true, status: "would_import" });
      return;
    }
    try {
      const result = await callSessionTargetGateway<SessionsCatalogImportResult>({
        gateway,
        method: "sessions.catalog.import",
        request: locator,
        requiredScope: "operator.write",
        timeoutMs: timeoutMs ?? 300_000,
      });
      record({
        ...locator,
        ...result,
        ok: true,
        status: result.created ? "imported" : result.importedItems > 0 ? "updated" : "unchanged",
      });
    } catch (error) {
      record({ ...locator, ok: false, status: "failed", error: formatErrorMessage(error) });
    }
  };
  const list = (request: SessionsCatalogListParams) =>
    callSessionTargetGateway<SessionsCatalogListResult>({
      gateway,
      method: "sessions.catalog.list",
      request,
      requiredScope: "operator.read",
      timeoutMs: timeoutMs ?? 300_000,
    });
  const limitReached = () => limit !== undefined && seen.size >= limit;
  const listParams = {
    ...(agentId ? { agentId } : {}),
    limitPerHost: Math.min(limit ?? 100, 100),
  };
  const importHost = async (
    id: string,
    initialHost: SessionCatalogHost,
    initialCatalogHasError: boolean,
  ) => {
    let host = initialHost;
    let catalogHasError = initialCatalogHasError;
    const cursors = new Set<string>();
    try {
      while (!limitReached()) {
        if (host.error) {
          record({
            catalogId: id,
            hostId: host.hostId,
            ok: false,
            status: "failed",
            error: host.error.message,
          });
        }
        for (const row of host.sessions) {
          if (limitReached()) {
            return;
          }
          const displayName = truncateUtf16Safe(row.name?.trim() ?? "", 500);
          await importOne({
            catalogId: id,
            hostId: host.hostId,
            threadId: row.threadId,
            ...(displayName ? { displayName } : {}),
            ...(row.sourceHomeId ? { sourceHomeId: row.sourceHomeId } : {}),
            ...(agentId ? { agentId } : {}),
          });
        }
        if (host.error || catalogHasError || !host.nextCursor || limitReached()) {
          return;
        }
        if (cursors.has(host.nextCursor)) {
          throw new Error("Catalog returned a repeated page cursor; import stopped for this host.");
        }
        cursors.add(host.nextCursor);
        const page = await list({
          ...listParams,
          catalogId: id,
          hostIds: [host.hostId],
          cursors: { [host.hostId]: host.nextCursor },
        });
        const nextCatalog = page.catalogs.find((candidate) => candidate.id === id);
        if (nextCatalog?.error) {
          catalogHasError = true;
          record({
            catalogId: id,
            ok: false,
            status: "failed",
            error: nextCatalog.error.message,
          });
        }
        const nextHost = nextCatalog?.hosts.find((candidate) => candidate.hostId === host.hostId);
        if (!nextHost) {
          if (catalogHasError) {
            return;
          }
          throw new Error("Catalog host disappeared while paging; retry the import to resume.");
        }
        host = nextHost;
      }
    } catch (error) {
      record({
        catalogId: id,
        hostId: host.hostId,
        ok: false,
        status: "failed",
        error: formatErrorMessage(error),
      });
    }
  };
  if (opts.all) {
    try {
      const page = await list({
        ...listParams,
        ...(catalog ? { catalogId: catalog } : {}),
        ...(hostId ? { hostIds: [hostId] } : {}),
      });
      for (const entry of page.catalogs) {
        if (limitReached()) {
          break;
        }
        if (entry.error) {
          record({ catalogId: entry.id, ok: false, status: "failed", error: entry.error.message });
        }
        for (const host of entry.hosts) {
          await importHost(entry.id, host, Boolean(entry.error));
        }
      }
    } catch (error) {
      record({ ok: false, status: "failed", error: formatErrorMessage(error) });
    }
  } else {
    const source = {
      catalogId: catalogId!,
      threadId: threadId!,
      ...(sourceHomeId ? { sourceHomeId } : {}),
      ...(agentId ? { agentId } : {}),
    };
    try {
      let selectedHostId = hostId;
      if (!selectedHostId) {
        const page = await list({
          catalogId: source.catalogId,
          ...(agentId ? { agentId } : {}),
          limitPerHost: 1,
        });
        const entry = page.catalogs.find((candidate) => candidate.id === source.catalogId);
        const hosts = entry?.hosts.filter((host) => host.kind === "gateway") ?? [];
        const selected =
          hosts.find((host) => host.hostId === "gateway:local") ??
          (hosts.length === 1 ? hosts[0] : undefined);
        if (!selected) {
          throw new Error(
            `No unambiguous Gateway host for catalog ${source.catalogId}. Pass --host <hostId> from sessions.catalog.list.${entry?.error ? ` ${entry.error.message}` : ""}`,
          );
        }
        selectedHostId = selected.hostId;
      }
      await importOne({ ...source, hostId: selectedHostId });
    } catch (error) {
      record({ ...source, ok: false, status: "failed", error: formatErrorMessage(error) });
    }
  }
  const count = (status: ImportResult["status"]) =>
    results.filter((row) => row.status === status).length;
  const summary = {
    imported: count("imported"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    wouldImport: count("would_import"),
    failed: count("failed"),
  };
  const ok = summary.failed === 0;
  if (opts.json) {
    writeRuntimeJson(runtime, {
      ...(ok ? { ok } : formatCliJsonFailure("Session import did not complete for every source.")),
      operation: "import",
      dryRun: Boolean(opts.dryRun),
      results,
      summary,
    });
  } else {
    runtime.log(
      opts.dryRun
        ? `${summary.wouldImport} would import; ${summary.failed} failed.`
        : `${summary.imported} imported; ${summary.updated} updated; ${summary.unchanged} unchanged; ${summary.failed} failed.`,
    );
  }
  if (!ok) {
    runtime.exit(1);
  }
}
