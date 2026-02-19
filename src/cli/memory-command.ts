#!/usr/bin/env node

/**
 * openclaw memory 命令 - 记忆系统易用性增强
 * 
 * 提供记忆统计、压缩、导出、导入、清理等功能
 */

import { Command } from "commander";
import { createMemoryUsabilityEnhancer } from "../agents/memory-usability.js";
import { loadConfig } from "../config/config.js";
import { logError } from "../logger.js";

const program = new Command();

program
  .name("openclaw memory")
  .description("Memory management utilities")
  .version("1.0.0");

// stats 命令
program
  .command("stats")
  .description("Show memory usage statistics")
  .option("--include-sessions", "Include session memories")
  .action(async (options) => {
    try {
      const config = loadConfig();
      const enhancer = createMemoryUsabilityEnhancer(config, "main");
      
      const stats = await enhancer.getUsageStats(options.includeSessions);
      
      console.log("\n📊 Memory Statistics");
      console.log("══════════════════════════════════════");
      console.log(`Total Files:      ${stats.totalFiles}`);
      console.log(`Total Size:       ${formatBytes(stats.totalSizeBytes)}`);
      console.log(`Total Chunks:     ${stats.totalChunks}`);
      console.log(`Average Chunk:    ${formatBytes(stats.averageChunkSize)}`);
      
      if (stats.oldestFile) {
        console.log(`Oldest File:      ${stats.oldestFile}`);
      }
      if (stats.newestFile) {
        console.log(`Newest File:      ${stats.newestFile}`);
      }
      
      if (options.includeSessions && stats.sessionFilePaths?.length) {
        console.log(`\nSession Files:    ${stats.sessionFilePaths.length}`);
      }
      
      console.log("══════════════════════════════════════\n");
    } catch (error) {
      logError(`Memory stats failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// compact 命令
program
  .command("compact")
  .description("Compact memory to reduce size")
  .option("--strategy <strategy>", "Compaction strategy (oldest_first|largest_first|least_relevant)", "oldest_first")
  .option("--retain-days <days>", "Number of days to retain", "7")
  .option("--target-size <bytes>", "Target size in bytes")
  .option("--dry-run", "Show what would be compacted without executing")
  .action(async (options) => {
    try {
      const config = loadConfig();
      const enhancer = createMemoryUsabilityEnhancer(config, "main");
      
      if (options.dryRun) {
        console.log("🔍 Dry run mode - no changes will be made\n");
      }
      
      const result = await enhancer.compact({
        strategy: options.strategy as any,
        retainLastDays: parseInt(options.retainDays, 10),
        targetSize: options.targetSize ? parseInt(options.targetSize, 10) : undefined,
      });
      
      if (result.success) {
        console.log("\n✅ Memory compaction successful");
        console.log("══════════════════════════════════════");
        console.log(`Strategy:         ${options.strategy}`);
        console.log(`Files Processed:  ${result.filesProcessed}`);
        if (result.spaceSavedBytes) {
          console.log(`Space Saved:      ${formatBytes(result.spaceSavedBytes)}`);
        }
        console.log("\nRecommendations:");
        result.recommendations.forEach(rec => console.log(`  • ${rec}`));
        console.log("══════════════════════════════════════\n");
      } else {
        logError(`Compaction failed: ${result.message}`);
        if (result.recommendations?.length) {
          console.log("\nRecommendations:");
          result.recommendations.forEach(rec => console.log(`  • ${rec}`));
        }
        process.exit(1);
      }
    } catch (error) {
      logError(`Memory compact failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// export 命令
program
  .command("export")
  .description("Export memory to file")
  .option("--format <format>", "Export format (json|markdown|plaintext)", "json")
  .option("--output <path>", "Output file path")
  .option("--include-sessions", "Include session memories")
  .action(async (options) => {
    try {
      const config = loadConfig();
      const enhancer = createMemoryUsabilityEnhancer(config, "main");
      
      const outputPath = options.output || `memory-export-${Date.now()}.${options.format === "json" ? "json" : "md"}`;
      
      const result = await enhancer.export({
        format: options.format as any,
        outputPath,
        includeSessions: options.includeSessions,
      });
      
      if (result.success) {
        console.log("\n✅ Memory export successful");
        console.log("══════════════════════════════════════");
        console.log(`Format:           ${options.format}`);
        console.log(`Output:           ${outputPath}`);
        console.log(`Files Exported:   ${result.filesProcessed}`);
        console.log("\nRecommendations:");
        result.recommendations.forEach(rec => console.log(`  • ${rec}`));
        console.log("══════════════════════════════════════\n");
      } else {
        logError(`Export failed: ${result.message}`);
        process.exit(1);
      }
    } catch (error) {
      logError(`Memory export failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// cleanup 命令
program
  .command("cleanup")
  .description("Clean up orphaned memory data")
  .option("--dry-run", "Show what would be cleaned without executing")
  .action(async (options) => {
    try {
      const config = loadConfig();
      const enhancer = createMemoryUsabilityEnhancer(config, "main");
      
      if (options.dryRun) {
        console.log("🔍 Dry run mode - no changes will be made\n");
      }
      
      const result = await enhancer.cleanup();
      
      if (result.success) {
        console.log("\n✅ Memory cleanup successful");
        console.log("══════════════════════════════════════");
        console.log(`Entries Removed:  ${result.filesProcessed}`);
        if (result.spaceSavedBytes) {
          console.log(`Space Saved:      ${formatBytes(result.spaceSavedBytes)}`);
        }
        console.log("\nRecommendations:");
        result.recommendations.forEach(rec => console.log(`  • ${rec}`));
        console.log("══════════════════════════════════════\n");
      } else {
        console.log(`ℹ️  ${result.message}`);
      }
    } catch (error) {
      logError(`Memory cleanup failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// optimize 命令
program
  .command("optimize")
  .description("Optimize memory (cleanup + compact if needed)")
  .action(async () => {
    try {
      const config = loadConfig();
      const enhancer = createMemoryUsabilityEnhancer(config, "main");
      
      const result = await enhancer.optimize();
      
      if (result.success) {
        console.log("\n✅ Memory optimization successful");
        console.log("══════════════════════════════════════");
        console.log("\nRecommendations:");
        result.recommendations.forEach(rec => console.log(`  • ${rec}`));
        console.log("══════════════════════════════════════\n");
      } else {
        logError(`Optimization failed: ${result.message}`);
        process.exit(1);
      }
    } catch (error) {
      logError(`Memory optimization failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// flush 命令
program
  .command("flush")
  .description("Flush old memory data")
  .option("--older-than <days>", "Flush data older than N days", "30")
  .option("--source <source>", "Source to flush (memory|sessions|both)", "both")
  .option("--dry-run", "Show what would be flushed without executing")
  .action(async (options) => {
    try {
      const config = loadConfig();
      const enhancer = createMemoryUsabilityEnhancer(config, "main");
      
      if (options.dryRun) {
        console.log("🔍 Dry run mode - no changes will be made\n");
      }
      
      const result = await enhancer.flush({
        olderThanDays: parseInt(options.olderThan, 10),
        source: options.source as any,
        dryRun: options.dryRun,
      });
      
      if (result.success) {
        console.log("\n✅ Memory flush successful");
        console.log("══════════════════════════════════════");
        console.log(`Source:           ${options.source}`);
        console.log(`Older Than:       ${options.olderThan} days`);
        console.log("\nRecommendations:");
        result.recommendations.forEach(rec => console.log(`  • ${rec}`));
        console.log("══════════════════════════════════════\n");
      } else {
        logError(`Flush failed: ${result.message}`);
        process.exit(1);
      }
    } catch (error) {
      logError(`Memory flush failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// summarize 命令
program
  .command("summarize")
  .description("Summarize large memory files using LLM")
  .option("--file <path>", "Specific file to summarize")
  .option("--threshold <kb>", "Size threshold in KB (default: 10)", "10")
  .option("--backup", "Create backup before summarizing")
  .option("--dry-run", "Show what would be summarized without executing")
  .action(async (options) => {
    try {
      const _config = loadConfig();

      const { MemoryFileSummarizer, findLargeMemoryFiles } = await import(
        "../memory/memory-file-summarizer.js"
      );

      const apiKey = process.env.ANTHROPIC_API_KEY || "";
      if (!apiKey) {
        logError("ANTHROPIC_API_KEY environment variable not set");
        process.exit(1);
      }

      const summarizer = new MemoryFileSummarizer({
        apiKey,
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-20250514",
      });

      const thresholdBytes = parseInt(options.threshold, 10) * 1024;
      const workspaceDir = process.cwd();

      if (options.file) {
        if (options.dryRun) {
          console.log("🔍 Dry run mode - no changes will be made\n");
          const { checkMemoryFileSizeThreshold } = await import(
            "../memory/memory-file-summarizer.js"
          );
          const wouldSummarize = await checkMemoryFileSizeThreshold(
            options.file,
            thresholdBytes,
          );
          console.log(`Would summarize: ${options.file}`);
          console.log(`Exceeds threshold: ${wouldSummarize ? "Yes" : "No"}`);
          return;
        }

        const result = await summarizer.summarizeAndReplace(options.file, {
          backup: options.backup,
        });

        if (result.success) {
          console.log("\n✅ Memory file summarized");
          console.log("══════════════════════════════════════");
          console.log(`File:        ${options.file}`);
          console.log(`Bytes Saved: ${formatBytes(result.bytesSaved || 0)}`);
          console.log("══════════════════════════════════════\n");
        } else {
          logError(`Summarization failed: ${result.error}`);
          process.exit(1);
        }
      } else {
        const largeFiles = await findLargeMemoryFiles({
          workspaceDir,
          thresholdBytes,
          maxFiles: 10,
        });

        if (largeFiles.length === 0) {
          console.log("\n✅ No memory files exceed the size threshold");
          console.log(`Threshold: ${options.threshold} KB\n`);
          return;
        }

        if (options.dryRun) {
          console.log("🔍 Dry run mode - no changes will be made\n");
          console.log(`Found ${largeFiles.length} files exceeding ${options.threshold} KB:\n`);
          for (const file of largeFiles) {
            console.log(`  • ${file}`);
          }
          return;
        }

        console.log(`\n📝 Summarizing ${largeFiles.length} large memory files...\n`);

        let totalSaved = 0;
        for (const file of largeFiles) {
          const result = await summarizer.summarizeAndReplace(file, {
            backup: options.backup,
          });

          if (result.success) {
            console.log(`  ✅ ${file} (saved ${formatBytes(result.bytesSaved || 0)})`);
            totalSaved += result.bytesSaved || 0;
          } else {
            console.log(`  ❌ ${file}: ${result.error}`);
          }
        }

        console.log("\n══════════════════════════════════════");
        console.log(`Total bytes saved: ${formatBytes(totalSaved)}`);
        console.log("══════════════════════════════════════\n");
      }
    } catch (error) {
      logError(`Memory summarize failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// 辅助函数
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// 导出供 CLI 使用
export { program };

// 如果是直接运行
if (require.main === module) {
  program.parse(process.argv);
}
