import path from "node:path";
import type { Command } from "commander";
import {
  createBlockedCourseCreatorLiveCrawlReport,
  createCourseCreatorLiveCrawlPack,
} from "../course-creator/live-crawl.js";
import { createCourseCreatorLiveSearchPack } from "../course-creator/live-search.js";
import {
  createCourseCreatorPackage,
  readCourseCreatorApprovalEvidence,
  readCourseCreatorLiveMoodleStagingReport,
} from "../course-creator/package.js";
import { defaultRuntime, type OutputRuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";

type CoursesCreateOptions = {
  outputRoot?: string;
  fixtureResearch?: boolean;
  mockSearchCrawl?: boolean;
  liveSearchCrawl?: boolean;
  liveSearchProvider?: string;
  liveSearchCount?: string;
  livePageCrawl?: boolean;
  livePageMaxChars?: string;
  researchPack?: string;
  mockMoodleStaging?: boolean;
  liveMoodleStagingReport?: string;
  approvalEvidence?: string;
  json?: boolean;
};

const DEFAULT_OUTPUT_ROOT = ".openclaw/course-creator";

function formatArtifactPath(filePath: string): string {
  return path.relative(process.cwd(), filePath) || ".";
}

function writeCreateSummary(
  runtime: OutputRuntimeEnv,
  result: ReturnType<typeof createCourseCreatorPackage>,
) {
  runtime.log(`Course Creator package: ${theme.info(result.slug)}`);
  runtime.log(`Status: ${theme.warn(result.status)}`);
  runtime.log(`Risk: ${result.riskTier}`);
  runtime.log(`Research: ${result.researchMode}`);
  runtime.log(`Publish: ${result.publishMode} (${result.publishReport.status})`);
  runtime.log(`Artifacts: ${formatArtifactPath(result.outputDir)}`);
  runtime.log(`Next build gap: ${result.nextBuildGap.title}`);
}

export function registerCoursesCli(program: Command, runtime: OutputRuntimeEnv = defaultRuntime) {
  const courses = program
    .command("courses")
    .description("Create local Course Creator packages from topic-only input")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/courses", "docs.openclaw.ai/cli/courses")}\n`,
    );

  courses
    .command("create")
    .description("Create a blocked, validated course package from a topic")
    .argument("<topic...>", "Course topic")
    .option("--output-root <path>", "Artifact output root", DEFAULT_OUTPUT_ROOT)
    .option("--fixture-research", "Generate deterministic fixture source snapshots")
    .option("--mock-search-crawl", "Generate deterministic topic-only mock search/crawl snapshots")
    .option("--live-search-crawl", "Use configured OpenClaw web_search for live source candidates")
    .option("--live-search-provider <id>", "Provider id for --live-search-crawl")
    .option("--live-search-count <count>", "Maximum live search results to accept")
    .option("--live-page-crawl", "Fetch and extract accepted live search result pages")
    .option("--live-page-max-chars <count>", "Maximum extracted characters per live page")
    .option("--research-pack <path>", "Read source and claim records from a JSON research pack")
    .option("--mock-moodle-staging", "Generate deterministic mock Moodle staging evidence")
    .option(
      "--live-moodle-staging-report <path>",
      "Read a live hidden Moodle staging certification report JSON",
    )
    .option("--approval-evidence <path>", "Read high-risk or public approval evidence JSON")
    .option("--json", "Print JSON output")
    .action(async (topicParts: string[], options: CoursesCreateOptions) => {
      await runCommandWithRuntime(runtime, async () => {
        const configuredResearchModes = [
          options.fixtureResearch,
          options.mockSearchCrawl,
          options.liveSearchCrawl,
          Boolean(options.researchPack),
        ].filter(Boolean).length;
        if (configuredResearchModes > 1) {
          throw new Error(
            "--fixture-research, --mock-search-crawl, --live-search-crawl, and --research-pack are mutually exclusive.",
          );
        }
        if (!options.liveSearchCrawl && (options.liveSearchProvider || options.liveSearchCount)) {
          throw new Error(
            "--live-search-provider and --live-search-count require --live-search-crawl.",
          );
        }
        if (!options.liveSearchCrawl && (options.livePageCrawl || options.livePageMaxChars)) {
          throw new Error(
            "--live-page-crawl and --live-page-max-chars require --live-search-crawl.",
          );
        }
        if (options.mockMoodleStaging && options.liveMoodleStagingReport) {
          throw new Error(
            "--mock-moodle-staging and --live-moodle-staging-report are mutually exclusive.",
          );
        }
        const liveSearchCount =
          options.liveSearchCount === undefined ? undefined : Number(options.liveSearchCount);
        const livePageMaxChars =
          options.livePageMaxChars === undefined ? undefined : Number(options.livePageMaxChars);
        if (
          options.liveSearchCount !== undefined &&
          (liveSearchCount === undefined ||
            !Number.isFinite(liveSearchCount) ||
            liveSearchCount <= 0)
        ) {
          throw new Error("--live-search-count must be a positive number.");
        }
        if (
          options.livePageMaxChars !== undefined &&
          (livePageMaxChars === undefined ||
            !Number.isFinite(livePageMaxChars) ||
            livePageMaxChars <= 0)
        ) {
          throw new Error("--live-page-max-chars must be a positive number.");
        }
        const topic = topicParts.join(" ");
        const liveSearch = options.liveSearchCrawl
          ? await createCourseCreatorLiveSearchPack({
              topic,
              providerId: options.liveSearchProvider,
              count: liveSearchCount,
            })
          : undefined;
        const liveCrawl =
          options.livePageCrawl && liveSearch?.researchPack
            ? await createCourseCreatorLiveCrawlPack({
                topic,
                researchPack: liveSearch.researchPack,
                maxChars: livePageMaxChars,
              })
            : options.livePageCrawl
              ? {
                  report: createBlockedCourseCreatorLiveCrawlReport({
                    requested: 0,
                    crawledAt: new Date().toISOString(),
                    error: "Live page crawl requires accepted live search sources first.",
                  }),
                }
              : undefined;
        const liveMoodleStagingReport = options.liveMoodleStagingReport
          ? readCourseCreatorLiveMoodleStagingReport(options.liveMoodleStagingReport)
          : undefined;
        const approvalEvidence = options.approvalEvidence
          ? readCourseCreatorApprovalEvidence(options.approvalEvidence)
          : undefined;
        const result = createCourseCreatorPackage({
          topic,
          outputRoot: options.outputRoot ?? DEFAULT_OUTPUT_ROOT,
          researchMode: options.researchPack
            ? "research_pack"
            : options.liveSearchCrawl
              ? "live_search"
              : options.mockSearchCrawl
                ? "mock_search_crawl"
                : options.fixtureResearch
                  ? "fixture"
                  : "none",
          researchPackPath: options.researchPack,
          researchPackInput: liveCrawl?.researchPack ?? liveSearch?.researchPack,
          liveSearchReport: liveSearch?.report,
          liveCrawlReport: liveCrawl?.report,
          liveMoodleStagingReport,
          approvalEvidence,
          publishMode: liveMoodleStagingReport
            ? "live_moodle_staging"
            : options.mockMoodleStaging
              ? "mock_moodle_staging"
              : "none",
        });
        if (options.json) {
          writeRuntimeJson(runtime, result);
          return;
        }
        writeCreateSummary(runtime, result);
      });
    });
}
