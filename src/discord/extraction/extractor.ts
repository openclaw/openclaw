/**
 * LLM Response Extractor
 *
 * Core extraction logic for identifying and cleaning LLM responses from terminal output.
 * Uses block-based extraction with pattern matching to filter UI noise.
 */

import type { LLMConfig, ExtractionResult, ExtractionMetrics } from "./types.js";
import { ExtractionError, ExtractionErrorCode } from "./types.js";
import { PatternMatcher, PatternUtils } from "./pattern-matcher.js";
import { getChildLogger } from "../../logging/logger.js";

const logger = getChildLogger({ module: "extraction" });

/**
 * Main extractor class for LLM terminal responses
 */
export class LLMResponseExtractor {
  private readonly noiseMatcher: PatternMatcher;
  private readonly stopMatcher: PatternMatcher;

  constructor(private readonly config: LLMConfig) {
    // Pre-compile pattern matchers for performance
    this.noiseMatcher = new PatternMatcher(config.noise_patterns);
    this.stopMatcher = new PatternMatcher(config.stop_patterns);
  }

  /**
   * Extract the most recent LLM response from terminal output
   *
   * @param terminalOutput - Raw terminal output from tmux capture-pane
   * @returns Extraction result with response and metrics
   */
  extract(terminalOutput: string): ExtractionResult {
    const startTime = Date.now();

    logger.debug("extraction_started", {
      llmType: this.config.name,
      outputLength: terminalOutput.length,
      lineCount: terminalOutput.split("\n").length,
    });

    try {
      const lines = terminalOutput.split("\n");

      // Step 1: Find the last response marker
      const lastResponseIdx = this.findLastResponseMarker(lines);

      if (lastResponseIdx === null) {
        logger.info("response_marker_not_found", {
          llmType: this.config.name,
          marker: this.config.response_marker,
          lineCount: lines.length,
        });

        return this.createResult(null, startTime, {
          responseFound: false,
          linesExtracted: 0,
          noiseLinesFiltered: 0,
        });
      }

      logger.debug("response_marker_found", {
        llmType: this.config.name,
        markerIndex: lastResponseIdx,
        totalLines: lines.length,
      });

      // Step 2: Extract from marker to next boundary
      const responseLines = this.extractUntilBoundary(lines, lastResponseIdx);

      // Step 3: Clean the first line (remove marker and echo)
      if (responseLines.length > 0) {
        responseLines[0] = this.cleanResponseStart(responseLines[0]);
      }

      // Step 4: Filter UI noise from all lines
      const originalLineCount = responseLines.length;
      const filteredLines = this.filterUINoise(responseLines);
      const noiseLinesFiltered = originalLineCount - filteredLines.length;

      logger.debug("noise_filtering_complete", {
        llmType: this.config.name,
        originalLines: originalLineCount,
        filteredLines: filteredLines.length,
        noiseLinesRemoved: noiseLinesFiltered,
      });

      // Step 5: Rejoin and trim
      const response = filteredLines.join("\n").trim();

      // Validate extraction
      const validationResult = this.validateExtraction(response);

      if (!validationResult.passed) {
        logger.warn("validation_failed", {
          llmType: this.config.name,
          reason: validationResult.reason,
          responseLength: response.length,
        });
      }

      logger.info("extraction_complete", {
        llmType: this.config.name,
        responseLength: response.length,
        linesExtracted: responseLines.length,
        noiseLinesFiltered,
        validationPassed: validationResult.passed,
        extractionTimeMs: Date.now() - startTime,
      });

      return this.createResult(response || null, startTime, {
        responseFound: response.length > 0,
        linesExtracted: responseLines.length,
        noiseLinesFiltered,
        validationPassed: validationResult.passed,
        validationFailure: validationResult.reason,
      });
    } catch (error) {
      const extractionError =
        error instanceof ExtractionError
          ? error
          : new ExtractionError(
              `Extraction failed: ${error}`,
              ExtractionErrorCode.MALFORMED_OUTPUT,
              true,
              terminalOutput.slice(-500),
            );

      logger.error("extraction_failed", {
        llmType: this.config.name,
        errorCode: extractionError.code,
        errorMessage: extractionError.message,
        recoverable: extractionError.recoverable,
        extractionTimeMs: Date.now() - startTime,
      });

      return this.createResult(
        null,
        startTime,
        {
          responseFound: false,
          linesExtracted: 0,
          noiseLinesFiltered: 0,
          validationPassed: false,
          validationFailure: extractionError.message,
        },
        extractionError,
      );
    }
  }

  /**
   * Find the index of the last line starting with the response marker
   */
  private findLastResponseMarker(lines: string[]): number | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      const stripped = lines[i].trimStart();
      if (stripped.startsWith(this.config.response_marker)) {
        return i;
      }
    }
    return null;
  }

  /**
   * Extract lines from start index until we hit a boundary
   *
   * Boundaries:
   * - Next prompt (line starting with prompt_marker)
   * - Match against stop_patterns
   * - End of output
   */
  private extractUntilBoundary(lines: string[], startIdx: number): string[] {
    const result: string[] = [];

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.trimStart();

      // Stop at next prompt (unless it's the first line)
      if (i > startIdx && stripped.startsWith(this.config.prompt_marker)) {
        break;
      }

      // Stop at patterns that mark boundaries
      if (this.stopMatcher.matchesAny(line)) {
        // For separators, definitely stop
        if (PatternUtils.isSeparatorLine(line)) {
          break;
        }
        // For other stop patterns, check if they're actual boundaries
        // (some patterns like feedback prompts are clear boundaries)
        const hasStopPrefix = this.config.stop_patterns
          .filter((p) => p.type === "prefix")
          .some((p) => stripped.startsWith(p.value || ""));

        if (hasStopPrefix) {
          break;
        }
      }

      result.push(line);
    }

    return result;
  }

  /**
   * Clean the first line of the response
   *
   * Remove:
   * - Response marker
   * - Echoed command content (e.g., "HEALTH_1770407657040")
   */
  private cleanResponseStart(firstLine: string): string {
    return PatternUtils.stripMarkerAndEcho(
      firstLine,
      this.config.response_marker,
      this.config.echo_pattern,
    );
  }

  /**
   * Filter out UI noise lines
   *
   * Removes:
   * - Lines matching noise patterns
   * - Empty lines (but preserve internal blank lines in multi-paragraph responses)
   * - Command output blocks (if special handling enabled)
   */
  private filterUINoise(lines: string[]): string[] {
    const filtered: string[] = [];
    let insideCommandBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.trimStart();

      // Handle special case: Codex command blocks
      if (this.config.special_handling?.command_blocks?.enabled) {
        // Detect start of command block (separator followed by command output markers)
        if (PatternUtils.isSeparatorLine(line)) {
          // Check if we're entering or leaving a command block
          const nextLineHasOutput =
            i + 1 < lines.length &&
            (lines[i + 1].trimStart().startsWith("│") || lines[i + 1].trimStart().startsWith("└"));

          if (nextLineHasOutput) {
            insideCommandBlock = true;
            continue; // Skip separator line
          } else if (insideCommandBlock) {
            insideCommandBlock = false;
            continue; // Skip separator line
          }
        }

        // Skip lines inside command blocks
        if (insideCommandBlock) {
          continue;
        }
      }

      // Skip lines matching noise patterns
      if (this.noiseMatcher.matchesAny(line)) {
        continue;
      }

      // Keep non-empty lines
      if (stripped) {
        filtered.push(line);
      } else if (filtered.length > 0) {
        // Preserve blank lines within response (for multi-paragraph)
        // but not at the start
        filtered.push("");
      }
    }

    // Trim trailing blank lines
    while (filtered.length > 0 && !filtered[filtered.length - 1].trim()) {
      filtered.pop();
    }

    return filtered;
  }

  /**
   * Validate the extracted response
   */
  private validateExtraction(response: string): { passed: boolean; reason?: string } {
    // Should not be empty
    if (!response || response.trim().length === 0) {
      return { passed: false, reason: "Response is empty" };
    }

    // Should not contain separator lines
    const lines = response.split("\n");
    for (const line of lines) {
      if (PatternUtils.isSeparatorLine(line)) {
        return { passed: false, reason: "Contains separator lines" };
      }
    }

    // Should not start with noise markers
    for (const pattern of this.config.noise_patterns) {
      if (pattern.type === "prefix" && response.trimStart().startsWith(pattern.value || "")) {
        return { passed: false, reason: `Starts with noise marker: ${pattern.value}` };
      }
    }

    // Should not contain prompt markers (except in quoted content)
    const firstLineStartsWithPrompt = lines[0]?.trimStart().startsWith(this.config.prompt_marker);
    if (firstLineStartsWithPrompt) {
      return { passed: false, reason: "Starts with prompt marker" };
    }

    return { passed: true };
  }

  /**
   * Create extraction result with metrics
   */
  private createResult(
    response: string | null,
    startTime: number,
    metrics: Partial<ExtractionMetrics>,
    error?: ExtractionError,
  ): ExtractionResult {
    const extractionTimeMs = Date.now() - startTime;

    const fullMetrics: ExtractionMetrics = {
      llmType: this.config.name,
      responseFound: metrics.responseFound ?? false,
      responseLength: response?.length ?? 0,
      linesExtracted: metrics.linesExtracted ?? 0,
      noiseLinesFiltered: metrics.noiseLinesFiltered ?? 0,
      extractionTimeMs,
      validationPassed: metrics.validationPassed ?? false,
      validationFailure: metrics.validationFailure,
    };

    return {
      response,
      metrics: fullMetrics,
      error,
    };
  }
}
