import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

const DEFAULT_AREA = "Warwickshire";
const DEFAULT_RADIUS_KM = 20;
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_MAX_ENTRY_BARRIER_SCORE = 6; // Include all — rank by barrier, don't filter
const SEARCH_BATCH_SIZE = 20;
const MAX_QUERIES_PER_RUN = 24;
const MAX_CANDIDATES_PER_RUN = 140;
const MAX_VERIFY_ATTEMPTS_PER_RUN = 60;
const VERIFY_TIME_BUDGET_MS = 90_000;
const EXPORT_DIR = "/home/node/.openclaw/exports/apprenticeship-hunter";
const AREA_HINTS = ["warwickshire", "coventry", "nuneaton", "rugby", "leamington", "warwick"];
const PRIMARY_VACANCY_HOSTS = new Set([
  "findapprenticeship.service.gov.uk",
  "www.findapprenticeship.service.gov.uk",
]);
const SECONDARY_VACANCY_HOSTS = new Set([
  "reed.co.uk",
  "www.reed.co.uk",
  "totaljobs.com",
  "www.totaljobs.com",
  "uk.indeed.com",
  "getmyfirstjob.co.uk",
  "www.getmyfirstjob.co.uk",
  "ratemyapprenticeship.co.uk",
  "www.ratemyapprenticeship.co.uk",
  "prospects.ac.uk",
  "www.prospects.ac.uk",
  "notgoingtouni.co.uk",
  "www.notgoingtouni.co.uk",
  "jobstoday.co.uk",
  "www.jobstoday.co.uk",
]);
const WARWICKSHIRE_POSTCODE_PREFIXES = [
  "CV1",
  "CV2",
  "CV3",
  "CV4",
  "CV5",
  "CV6",
  "CV7",
  "CV8",
  "CV9",
  "CV10",
  "CV11",
  "CV12",
  "CV21",
  "CV22",
  "CV23",
  "CV31",
  "CV32",
  "CV33",
  "CV34",
  "CV35",
  "CV36",
  "CV37",
];

const ApprenticeshipHunterSchema = Type.Object({
  area: Type.Optional(Type.String({ description: "Target UK area (default Warwickshire)." })),
  radiusKm: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  excludeUrls: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "URLs to exclude from this run (use for pagination, e.g., next 50 after previous batch).",
    }),
  ),
  sectors: Type.Optional(
    Type.Array(Type.String(), {
      description: "Preferred sectors (e.g. retail, video editing, videography).",
    }),
  ),
  outputFormats: Type.Optional(
    Type.Array(Type.String(), {
      description: "Requested artifact formats (supports csv and pdf).",
    }),
  ),
  maxEntryBarrierScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 6,
      description: "Maximum entry-barrier band (default 2 = up to A-level/Level 3).",
    }),
  ),
});

type VacancyRow = {
  title: string;
  employer: string;
  location: string;
  qualification_band: string;
  score: number;
  sector_score: number;
  url: string;
  source: string;
};

type SearchPayload = {
  status?: string;
  results?: Array<{ url?: string; title?: string; description?: string }>;
};

export function createApprenticeshipHunterTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });

  if (!webSearchTool || !webFetchTool) {
    return null;
  }

  return {
    label: "Apprenticeship Hunter",
    name: "apprenticeship_hunter",
    description:
      "Find live UK apprenticeship vacancies, verify URLs with web_fetch, rank lowest barrier-to-entry first, and export CSV/PDF artifacts.",
    parameters: ApprenticeshipHunterSchema,
    execute: async (_toolCallId, params) => {
      const area = readStringParam(params, "area") ?? DEFAULT_AREA;
      const radiusKm = Math.max(
        1,
        Math.min(100, readNumberParam(params, "radiusKm", { integer: true }) ?? DEFAULT_RADIUS_KM),
      );
      const maxResults = Math.max(
        1,
        Math.min(
          50,
          readNumberParam(params, "maxResults", { integer: true }) ?? DEFAULT_MAX_RESULTS,
        ),
      );
      const excludeUrls = normalizeExcludedUrls(readStringArrayParam(params, "excludeUrls") ?? []);
      const sectors = normalizeSectors(readStringArrayParam(params, "sectors") ?? []);
      const outputFormats = normalizeFormats(readStringArrayParam(params, "outputFormats") ?? []);
      const maxEntryBarrierScore = Math.max(
        0,
        Math.min(
          6,
          readNumberParam(params, "maxEntryBarrierScore", { integer: true }) ??
            DEFAULT_MAX_ENTRY_BARRIER_SCORE,
        ),
      );

      const queries = buildQueries({ area, radiusKm, sectors });
      const candidates = await collectCandidateUrls(webSearchTool, queries, excludeUrls);
      const rows = await verifyAndRankRows(
        webFetchTool,
        candidates,
        maxResults,
        area,
        sectors,
        maxEntryBarrierScore,
      );

      if (rows.length === 0) {
        return jsonResult({
          status: "error",
          result: "TOOL_FAILED",
          reason: "no verified live in-scope apprenticeship vacancies",
          scanned: candidates.length,
        });
      }

      await fs.mkdir(EXPORT_DIR, { recursive: true });
      const csvPath = path.join(EXPORT_DIR, "ranked.csv");
      const pdfPath = path.join(EXPORT_DIR, "ranked.pdf");
      const paramsPath = path.join(EXPORT_DIR, "search-params.json");

      const csvContent = toCsv(rows);
      await fs.writeFile(csvPath, csvContent, "utf8");
      await fs.writeFile(
        paramsPath,
        JSON.stringify(
          {
            area,
            radiusKm,
            maxResults,
            excludeUrlsCount: excludeUrls.size,
            sectors,
            outputFormats: [...outputFormats].toSorted(),
            maxEntryBarrierScore,
            savedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      if (outputFormats.has("pdf")) {
        const pdf = buildSimplePdf(
          rows.map(
            (row, idx) =>
              `${idx + 1}. ${row.title} | ${row.employer} | ${row.location} | ${row.qualification_band} | ${row.url}`,
          ),
        );
        await fs.writeFile(pdfPath, pdf);
      }

      return jsonResult({
        status: "ok",
        rows: rows.length,
        // Hide internal ranking fields in the public response payload.
        result: rows.map(({ score: _score, sector_score: _sector_score, ...rest }) => rest),
        exports: {
          csv: csvPath,
          pdf: outputFormats.has("pdf") ? pdfPath : null,
          params: paramsPath,
        },
        next: {
          mode: "excludeUrls_paging",
          suggestedBatchSize: 50,
          excludeUrls: rows.map((row) => row.url),
          hint: "Pass these URLs as excludeUrls with maxResults=50 to fetch the next batch, or run recurring mode until STOP.",
        },
      });
    },
  };
}

function normalizeSectors(input: string[]): string[] {
  const cleaned = input
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
  if (cleaned.length === 0) {
    return ["retail", "video editing", "videography"];
  }
  return [...new Set(cleaned)];
}

function normalizeFormats(input: string[]): Set<string> {
  const formats = new Set(input.map((value) => value.trim().toLowerCase()));
  if (formats.size === 0) {
    formats.add("csv");
    formats.add("pdf");
  }
  return formats;
}

function normalizeExcludedUrls(input: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const candidate of input) {
    const url = normalizeUrl(candidate);
    if (!url) {
      continue;
    }
    normalized.add(url);
  }
  return normalized;
}

function buildQueries(params: { area: string; radiusKm: number; sectors: string[] }) {
  const normalizedArea = params.area.trim();
  const queries = new Set<string>();
  const sectors = expandSectorQueries(params.sectors);
  const areaTokens = [normalizedArea, ...AREA_HINTS].slice(0, 4);
  const govSite = "site:findapprenticeship.service.gov.uk/apprenticeship";
  const year = new Date().getFullYear();

  // Sector-specific queries first — free-text (no site: operator) for much better coverage.
  // site: operator queries return very few results from Brave for sector+location combos.
  for (const sector of sectors) {
    queries.add(`"${sector}" apprenticeship "${normalizedArea}" ${year}`);
    queries.add(`"${sector}" apprentice "${normalizedArea}" apply`);
    queries.add(`${sector} apprenticeship ${normalizedArea} vacancies apply ${year}`);
    queries.add(`${sector} apprenticeship ${normalizedArea} getmyfirstjob ratemyapprenticeship`);
    if (queries.size >= MAX_QUERIES_PER_RUN) {
      break;
    }
  }

  // Gov site: general area queries (reliable for any apprenticeship)
  queries.add(`${govSite} "${normalizedArea}" apprenticeship`);
  queries.add(`${govSite} "${normalizedArea}" entry level apprenticeship`);
  queries.add(`${govSite} "${normalizedArea}" "level 2" apprenticeship`);
  queries.add(`${govSite} "${normalizedArea}" "level 3" apprenticeship`);
  queries.add(`${govSite} "${normalizedArea}" apply now apprenticeship`);
  queries.add(`${govSite}/VAC "${normalizedArea}" apprenticeship`);
  queries.add(`${govSite}/reference "${normalizedArea}" apprenticeship`);

  // Gov site: sector-specific (belt-and-braces, in case Brave indexes them)
  for (const sector of sectors) {
    if (queries.size >= MAX_QUERIES_PER_RUN) {
      break;
    }
    queries.add(`${govSite} "${normalizedArea}" ${sector} apprenticeship`);
    queries.add(`${govSite}/VAC "${normalizedArea}" ${sector}`);
  }

  // Job board site: queries for area tokens
  for (const token of areaTokens) {
    if (queries.size >= MAX_QUERIES_PER_RUN) {
      break;
    }
    queries.add(`site:reed.co.uk/jobs "${token}" apprenticeship`);
    queries.add(`site:totaljobs.com/jobs "${token}" apprenticeship`);
    if (queries.size < MAX_QUERIES_PER_RUN) {
      queries.add(`site:uk.indeed.com "${token}" apprenticeship`);
    }
    if (queries.size < MAX_QUERIES_PER_RUN) {
      queries.add(`site:getmyfirstjob.co.uk "${token}" apprenticeship`);
    }
    if (queries.size < MAX_QUERIES_PER_RUN) {
      queries.add(`site:ratemyapprenticeship.co.uk "${token}"`);
    }
  }

  // Postcode-based fallback for Warwickshire
  for (const prefix of WARWICKSHIRE_POSTCODE_PREFIXES.slice(0, 3)) {
    if (queries.size >= MAX_QUERIES_PER_RUN) {
      break;
    }
    queries.add(`${govSite} "${prefix}" apprenticeship`);
    if (queries.size < MAX_QUERIES_PER_RUN) {
      queries.add(`site:reed.co.uk/jobs "${prefix}" apprenticeship`);
    }
  }

  if (queries.size < MAX_QUERIES_PER_RUN) {
    queries.add(`site:reed.co.uk/jobs "${normalizedArea}" trainee`);
  }
  if (queries.size < MAX_QUERIES_PER_RUN) {
    queries.add(`site:uk.indeed.com "${normalizedArea}" trainee apprenticeship`);
  }

  return [...queries].slice(0, MAX_QUERIES_PER_RUN);
}

function expandSectorQueries(sectors: string[]): string[] {
  const expanded: string[] = [];
  for (const sector of sectors) {
    expanded.push(sector);
    if (sector === "retail") {
      expanded.push("retail team member");
      expanded.push("customer service");
    } else if (sector === "video editing") {
      expanded.push("video editor");
      expanded.push("digital content");
    } else if (sector === "videography") {
      expanded.push("videographer");
      expanded.push("content creator");
    }
  }
  return [...new Set(expanded)].slice(0, 8);
}

async function collectCandidateUrls(
  webSearchTool: AnyAgentTool,
  queries: string[],
  excludedUrls: Set<string>,
): Promise<Array<{ url: string; source: string; searchTitle: string; searchDescription: string }>> {
  const seen = new Set<string>(excludedUrls);
  const candidates: Array<{
    url: string;
    source: string;
    searchTitle: string;
    searchDescription: string;
  }> = [];
  for (const query of queries) {
    if (candidates.length >= MAX_CANDIDATES_PER_RUN) {
      break;
    }
    const payload = await runSearchWithFallback(webSearchTool, query);
    if (payload?.status === "error") {
      continue;
    }
    for (const item of payload?.results ?? []) {
      const url = normalizeUrl(item?.url);
      if (!url) {
        continue;
      }
      if (!isAllowedVacancyUrl(url)) {
        continue;
      }
      if (
        !shouldKeepCandidateByPreview(
          url,
          String(item?.title ?? ""),
          String(item?.description ?? ""),
        )
      ) {
        continue;
      }
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      candidates.push({
        url,
        source: query,
        searchTitle: stripWrapperText(String(item?.title ?? "")).trim(),
        searchDescription: stripWrapperText(String(item?.description ?? "")).trim(),
      });
      if (candidates.length >= MAX_CANDIDATES_PER_RUN) {
        break;
      }
    }
  }
  return candidates;
}

async function runSearchWithFallback(
  webSearchTool: AnyAgentTool,
  query: string,
): Promise<SearchPayload | undefined> {
  const primary = await executeSearch(webSearchTool, `ah-search:${query}:primary`, {
    query,
    count: SEARCH_BATCH_SIZE,
    search_lang: "en",
    country: "GB",
  });
  if (hasSearchResults(primary)) {
    return primary;
  }

  const fallbackQuery = sanitizeSearchQuery(query);
  const fallback = await executeSearch(webSearchTool, `ah-search:${query}:fallback`, {
    query: fallbackQuery,
    count: Math.min(SEARCH_BATCH_SIZE, 10),
  });
  if (hasSearchResults(fallback)) {
    return fallback;
  }
  return primary ?? fallback;
}

async function executeSearch(
  webSearchTool: AnyAgentTool,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<SearchPayload | undefined> {
  try {
    const searchResult = await webSearchTool.execute(toolCallId, params);
    return searchResult.details as SearchPayload | undefined;
  } catch (error) {
    if (isBraveValidationError(error)) {
      return undefined;
    }
    // Keep going; one failed query should not fail the entire hunt.
    return undefined;
  }
}

function hasSearchResults(payload: SearchPayload | undefined): boolean {
  return Array.isArray(payload?.results) && payload.results.length > 0;
}

function sanitizeSearchQuery(query: string): string {
  return query
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function isBraveValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("brave search api error (422)") ||
    (message.includes("brave search api error") && message.includes("validation"))
  );
}

async function verifyAndRankRows(
  webFetchTool: AnyAgentTool,
  candidates: Array<{
    url: string;
    source: string;
    searchTitle: string;
    searchDescription: string;
  }>,
  maxResults: number,
  area: string,
  sectors: string[],
  maxEntryBarrierScore: number,
): Promise<VacancyRow[]> {
  const inAreaPreferred: VacancyRow[] = [];
  const inAreaOther: VacancyRow[] = [];
  const startedAt = Date.now();
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= MAX_VERIFY_ATTEMPTS_PER_RUN) {
      break;
    }
    if (Date.now() - startedAt > VERIFY_TIME_BUDGET_MS) {
      break;
    }
    if (inAreaPreferred.length + inAreaOther.length >= maxResults * 3) {
      break;
    }
    attempts += 1;
    let payload:
      | {
          status?: number;
          title?: string;
          text?: string;
        }
      | undefined;
    try {
      const fetchResult = await webFetchTool.execute(`ah-fetch:${candidate.url}`, {
        url: candidate.url,
        maxChars: 6000,
      });
      payload = fetchResult.details as
        | {
            status?: number;
            title?: string;
            text?: string;
          }
        | undefined;
    } catch {
      // Some external job boards block automation (e.g. Cloudflare).
      // Skip blocked pages and continue with other candidates.
      continue;
    }
    if (!payload || payload.status !== 200) {
      continue;
    }
    const text = String(payload.text ?? "");
    const title = stripWrapperText(String(payload.title ?? ""));
    if (isClosedVacancy(title, text)) {
      continue;
    }
    if (!isLikelyVacancyPage(candidate.url, title, text)) {
      continue;
    }
    const rowTitle =
      cleanupTitle(title) ||
      cleanupTitle(candidate.searchTitle) ||
      parseVacancyTitle(text) ||
      parseVacancyTitle(candidate.searchDescription) ||
      "Unknown title";
    const employer =
      parseEmployer(text) ||
      parseEmployerFromTitle(title) ||
      parseEmployerFromTitle(candidate.searchTitle) ||
      "Unknown employer";
    const location =
      parseLocation(text) ||
      parseLocation(`${candidate.searchTitle}\n${candidate.searchDescription}`) ||
      "Unknown location";
    const score = entryBarrierScore(`${rowTitle}\n${text}`);
    if (score > maxEntryBarrierScore) {
      continue;
    }
    const sectorScore = scoreSectorMatch(
      `${rowTitle}\n${candidate.searchTitle}\n${candidate.searchDescription}\n${text}`,
      sectors,
    );
    const row = {
      title: rowTitle,
      employer,
      location,
      qualification_band: barrierLabel(score),
      score,
      sector_score: sectorScore,
      url: candidate.url,
      source: candidate.source,
    };
    if (isInArea(row, area)) {
      if (sectorScore > 0) {
        inAreaPreferred.push(row);
      } else {
        inAreaOther.push(row);
      }
    }
  }
  inAreaPreferred.sort(
    (a, b) =>
      a.score - b.score || b.sector_score - a.sector_score || a.title.localeCompare(b.title),
  );
  inAreaOther.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));

  // When sectors were specified and we found sector-matched results, don't pad with
  // unrelated roles — they confuse the output. Only fall back to inAreaOther if the
  // sector search genuinely returned nothing at all.
  const hasSectorResults = inAreaPreferred.length > 0;
  const sectorsWereSpecified = sectors.length > 0;
  const combined =
    sectorsWereSpecified && hasSectorResults
      ? inAreaPreferred
      : [...inAreaPreferred, ...inAreaOther];

  return combined.slice(0, maxResults);
}

function scoreSectorMatch(haystackRaw: string, sectors: string[]): number {
  const haystack = haystackRaw.toLowerCase();
  let score = 0;
  for (const sector of sectors) {
    const keywords =
      sector === "retail"
        ? ["retail", "customer service", "sales assistant", "store", "shop"]
        : sector === "video editing"
          ? ["video editing", "video editor", "digital content", "content creator"]
          : sector === "videography"
            ? ["videography", "videographer", "video production", "camera operator"]
            : [sector];
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      score += 1;
    }
  }
  return score;
}

function normalizeUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return null;
  }
  return trimmed;
}

function isAllowedVacancyUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (PRIMARY_VACANCY_HOSTS.has(host)) {
    return (
      /^\/apprenticeship\/VAC\d+\/?$/i.test(parsed.pathname) ||
      /^\/apprenticeship\/reference\/\d+\/?$/i.test(parsed.pathname)
    );
  }
  if (!SECONDARY_VACANCY_HOSTS.has(host)) {
    return false;
  }
  if (/\/jobs\/?$/.test(parsed.pathname) || parsed.pathname.includes("/search")) {
    return false;
  }
  if (host.includes("reed.co.uk")) {
    return /\/jobs\/.+/.test(parsed.pathname);
  }
  if (host.includes("totaljobs.com")) {
    return /\/job\/.+/.test(parsed.pathname) || /\/jobs\/.+/.test(parsed.pathname);
  }
  if (host.includes("indeed.com")) {
    return parsed.pathname.includes("/viewjob") || parsed.searchParams.has("jk");
  }
  if (host.includes("getmyfirstjob.co.uk")) {
    return /\/(vacancy|apprenticeship|job)\/.+/.test(parsed.pathname);
  }
  if (host.includes("ratemyapprenticeship.co.uk")) {
    return /\/(vacancies?|apprenticeship)\/.+/.test(parsed.pathname);
  }
  if (host.includes("prospects.ac.uk")) {
    return /\/job-profile\/.+/.test(parsed.pathname) || /\/(job|vacancy)\/.+/.test(parsed.pathname);
  }
  if (host.includes("notgoingtouni.co.uk")) {
    return /\/(apprenticeship|vacancy)\/.+/.test(parsed.pathname);
  }
  if (host.includes("jobstoday.co.uk")) {
    return /\/(job|vacancy)\/.+/.test(parsed.pathname);
  }
  return false;
}

function shouldKeepCandidateByPreview(
  url: string,
  titleRaw: string,
  descriptionRaw: string,
): boolean {
  const title = stripWrapperText(titleRaw).toLowerCase();
  const description = stripWrapperText(descriptionRaw).toLowerCase();
  const preview = `${title}\n${description}`;
  if (!preview.trim()) {
    return true;
  }
  if (/(usa|united states|canada|ontario|alberta|british columbia)/i.test(preview)) {
    return false;
  }
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (PRIMARY_VACANCY_HOSTS.has(host)) {
    return true;
  }
  // Non-gov sources are noisier; require at least one apprenticeship indicator.
  return /(apprentice|apprenticeship|trainee)/.test(preview);
}

function stripWrapperText(value: string): string {
  return value
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")
    .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")
    .replace(/Source:\s*Web Fetch/gi, "")
    .replace(/Source:\s*Web Search/gi, "")
    .replace(/^\s*---\s*$/gm, "")
    .trim();
}

function isClosedVacancy(title: string, text: string): boolean {
  const haystack = `${title}\n${text}`.toLowerCase();
  return (
    haystack.includes("you can no longer apply") ||
    haystack.includes("this apprenticeship closed") ||
    haystack.includes("closed on ")
  );
}

function isLikelyVacancyPage(url: string, title: string, text: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const haystack = `${title}\n${text}`.toLowerCase();
  if (PRIMARY_VACANCY_HOSTS.has(host)) {
    if (!url.includes("findapprenticeship.service.gov.uk/apprenticeship/")) {
      return false;
    }
    if (haystack.includes("cookies on find an apprenticeship")) {
      return false;
    }
    if (haystack.includes("results found (page ")) {
      return false;
    }
    if (
      haystack.includes("find more apprenticeships") &&
      !/(apply now|closes on|start date)/.test(haystack)
    ) {
      return false;
    }
    if (!/(closes on|start date|positions available|training course|apply now)/.test(haystack)) {
      return false;
    }
    return haystack.includes("apprenticeship");
  }
  if (isSearchOrListingShell(url, haystack)) {
    return false;
  }
  if (!/(apprentice|apprenticeship|trainee)/.test(haystack)) {
    return false;
  }
  if (!/(apply|job description|responsibilities|salary|location|hours)/.test(haystack)) {
    return false;
  }
  return true;
}

function isSearchOrListingShell(url: string, haystack: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (/\/jobs\/?$/.test(lowerUrl)) {
    return true;
  }
  if (lowerUrl.includes("/search") || lowerUrl.includes("page=") || lowerUrl.includes("results")) {
    return true;
  }
  if (/results\s+for/.test(haystack) || /jobs\s+found/.test(haystack)) {
    return true;
  }
  return false;
}

function parseVacancyTitle(text: string): string | null {
  const matches = [...text.matchAll(/###\s+([^\n]+)/g)];
  for (const match of matches) {
    const title = match[1]?.trim() ?? "";
    if (!title) {
      continue;
    }
    if (/^(what you'll do at work|summary|contents)$/i.test(title)) {
      continue;
    }
    if (/apprentice|apprenticeship/i.test(title)) {
      return title;
    }
  }
  return matches[0]?.[1]?.trim() || null;
}

function parseEmployer(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const idx = lines.findIndex(
    (line) => line.startsWith("### ") && /apprentice|apprenticeship/i.test(line),
  );
  if (idx >= 0 && idx + 1 < lines.length) {
    const employer = lines[idx + 1].replace(/^[-#\s]+/, "").trim();
    if (
      employer &&
      employer.length <= 100 &&
      !/[.!?]/.test(employer) &&
      !looksLikeLocationOrPostcode(employer) &&
      !/^(what you'll do at work|summary|contents)$/i.test(employer)
    ) {
      return employer;
    }
  }
  const uppercaseLine = lines.find(
    (line) =>
      line.length > 3 &&
      line.length < 120 &&
      /[A-Z]/.test(line) &&
      line === line.toUpperCase() &&
      !looksLikeLocationOrPostcode(line) &&
      !line.includes("APPRENTICESHIP"),
  );
  if (uppercaseLine) {
    return uppercaseLine;
  }
  return null;
}

function parseEmployerFromTitle(title: string): string | null {
  const cleaned = cleanupTitle(title);
  if (!cleaned) {
    return null;
  }
  if (/apprentice|apprenticeship/i.test(cleaned)) {
    return null;
  }
  const parts = cleaned.split(" - ");
  if (parts.length >= 2) {
    const employer = parts[parts.length - 1].trim();
    if (!employer || looksLikeLocationOrPostcode(employer)) {
      return null;
    }
    return employer;
  }
  return null;
}

function looksLikeLocationOrPostcode(value: string): boolean {
  const plain = value.trim();
  if (!plain) {
    return false;
  }
  if (/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(plain)) {
    return true;
  }
  if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(plain) && plain.length <= 16) {
    return true;
  }
  return /(warwick|coventry|nuneaton|rugby|leamington|kenilworth|gallows hill)/i.test(plain);
}

function parseLocation(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(line)) {
      return line.replace(/^[-#\s]+/, "").trim();
    }
  }
  for (const line of lines) {
    if (/(warwickshire|coventry|nuneaton|rugby|leamington|warwick|kenilworth)/i.test(line)) {
      return line.replace(/^[-#\s]+/, "").trim();
    }
  }
  return null;
}

function cleanupTitle(title: string): string {
  return title
    .replace(/–\s*Find an apprenticeship.*$/i, "")
    .replace(/–\s*reed\.co\.uk.*$/i, "")
    .replace(/-\s*Reed\.co\.uk.*$/i, "")
    .replace(/-\s*Totaljobs.*$/i, "")
    .replace(/\|\s*Indeed.*$/i, "")
    .replace(/You can no longer apply for this apprenticeship.*$/i, "")
    .replace(/^Cookies on Find an apprenticeship$/i, "")
    .trim();
}

function isInArea(row: VacancyRow, area: string): boolean {
  const haystack = `${row.location} ${row.title}`.toLowerCase();
  const target = area.toLowerCase();
  if (haystack.includes(target)) {
    return true;
  }
  const warwickshireTarget = /(warwickshire|coventry|nuneaton|rugby|leamington|warwick)/i.test(
    target,
  );
  if (warwickshireTarget && hasWarwickshirePostcodePrefix(row.location)) {
    return true;
  }
  return getAreaHints(area).some((hint) => haystack.includes(hint));
}

function hasWarwickshirePostcodePrefix(location: string): boolean {
  const normalized = location.toUpperCase();
  return WARWICKSHIRE_POSTCODE_PREFIXES.some((prefix) => normalized.includes(prefix.toUpperCase()));
}

function getAreaHints(area: string): string[] {
  const normalizedArea = area.trim().toLowerCase();
  const fromArea = normalizedArea
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  if (normalizedArea.includes("warwick")) {
    return [...new Set([...AREA_HINTS, ...fromArea])];
  }
  return [...new Set(fromArea)];
}

function entryBarrierScore(text: string): number {
  const value = text.toLowerCase();
  if (
    /(no (formal )?qualifications|no experience|full training|no prior experience|we('ll| will) train|no previous experience|entry.?level|school leavers?|school leaver|all training provided|training provided|no requirements)/.test(
      value,
    )
  ) {
    return 0;
  }
  if (/(gcse|level 2)/.test(value)) {
    return 1;
  }
  if (/(a-?level|level 3)/.test(value)) {
    return 2;
  }
  if (/(foundation|level 4|level 5)/.test(value)) {
    return 3;
  }
  if (/(bachelor|degree required)/.test(value)) {
    return 4;
  }
  if (/(postgraduate|masters|phd)/.test(value)) {
    return 5;
  }
  // "Not stated" — assume accessible (apprenticeships are entry-level by definition)
  return 2;
}

function barrierLabel(score: number): string {
  switch (score) {
    case 0:
      return "No formal qualifications";
    case 1:
      return "GCSE/equivalent";
    case 2:
      return "A-level/Level 3";
    case 3:
      return "Level 4-5/Foundation";
    case 4:
      return "Bachelor required";
    case 5:
      return "Postgraduate+";
    default:
      return "Not stated";
  }
}

function toCsv(rows: VacancyRow[]): string {
  const header = ["title", "employer", "location", "qualification_band", "url"];
  const body = rows.map((row) =>
    [
      encodeCsvValue(row.title),
      encodeCsvValue(row.employer),
      encodeCsvValue(row.location),
      encodeCsvValue(row.qualification_band),
      encodeCsvValue(row.url),
    ].join(","),
  );
  return `${header.join(",")}\n${body.join("\n")}\n`;
}

function encodeCsvValue(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSimplePdf(lines: string[]): Buffer {
  const limited = lines.slice(0, 40);
  const content = [
    "BT",
    "/F1 10 Tf",
    "50 780 Td",
    ...limited.flatMap((line, idx) =>
      idx === 0 ? [`(${pdfEscape(line)}) Tj`] : ["0 -14 Td", `(${pdfEscape(line)}) Tj`],
    ),
    "ET",
  ].join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];

  let offset = "%PDF-1.4\n".length;
  const xref: number[] = [0];
  for (const obj of objects) {
    xref.push(offset);
    offset += Buffer.byteLength(obj, "utf8");
  }
  const xrefStart = offset;
  const xrefBody = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...xref.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    `${xrefStart}`,
    "%%EOF\n",
  ].join("\n");

  return Buffer.from(`%PDF-1.4\n${objects.join("")}${xrefBody}`, "utf8");
}
