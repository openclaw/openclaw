/**
 * Config Validator - Pre-flight validation for openclaw.json
 * 
 * Prevents silent crashes by validating config before gateway startup.
 * Provides clear, actionable error messages when config is invalid.
 */

import * as fs from "fs";
import * as path from "path";

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  config?: any;
  filePath?: string;
}

/**
 * Validate openclaw.json before gateway startup
 */
export function validateConfigFile(configPath: string): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let config;

  // Step 1: Check file exists
  if (!fs.existsSync(configPath)) {
    return {
      valid: false,
      errors: [
        `Config file not found: ${configPath}`,
        `Create one by running: openclaw onboard`,
      ],
      warnings: [],
      filePath: configPath,
    };
  }

  // Step 2: Parse JSON with detailed error reporting
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err) {
    const parseErr = err instanceof SyntaxError ? err.message : String(err);
    return {
      valid: false,
      errors: [
        `Invalid JSON in ${configPath}`,
        `Error: ${parseErr}`,
        `Common fixes:`,
        `  - Missing comma between properties`,
        `  - Unclosed brace } or bracket ]`,
        `  - Unescaped quotes in strings`,
        `  - Trailing comma before }`,
      ],
      warnings: [],
      filePath: configPath,
    };
  }

  // Step 3: Type validation for known sections
  if (config.auth && typeof config.auth !== "object") {
    errors.push(`auth must be an object, got ${typeof config.auth}`);
  }

  if (config.agents && typeof config.agents !== "object") {
    errors.push(`agents must be an object, got ${typeof config.agents}`);
  }

  if (
    config.agents?.defaults?.models &&
    typeof config.agents.defaults.models !== "object"
  ) {
    errors.push(
      `agents.defaults.models must be an object, got ${typeof config.agents.defaults.models}`
    );
  }

  // Step 4: Warn about incomplete model configurations
  if (config.agents?.defaults?.models) {
    for (const modelKey of Object.keys(config.agents.defaults.models)) {
      // Check if this model has a corresponding provider configured
      const modelParts = modelKey.split("/");
      if (modelParts.length === 2) {
        const provider = modelParts[0];
        if (provider !== "default" && !config.auth?.profiles?.[`${provider}:default`]) {
          // Only warn if it's a known external provider
          if (["anthropic", "openai", "google", "moonshot"].includes(provider)) {
            warnings.push(
              `Model '${modelKey}' is listed but auth profile '${provider}:default' not found. This model may not work.`
            );
          }
        }
      }
    }
  }

  // Step 5: Warn about deprecated or suspicious configurations
  if (config.env?.MOONSHOT_API_KEY && !config.auth?.profiles?.["moonshot:default"]) {
    warnings.push(
      `MOONSHOT_API_KEY found in env but no auth.profiles['moonshot:default']. Consider migrating to auth config.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    config: errors.length === 0 ? config : undefined,
    filePath: configPath,
  };
}

/**
 * Log validation results in human-readable format
 */
export function logConfigValidation(result: ConfigValidationResult): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  CONFIG VALIDATION REPORT`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  File: ${result.filePath}`);

  if (result.valid) {
    console.log(`  Status: ✅ VALID\n`);
  } else {
    console.error(`  Status: ❌ INVALID\n`);
    console.error(`  ERRORS:`);
    for (const err of result.errors) {
      console.error(`    ${err}`);
    }
    console.error("");
  }

  if (result.warnings.length > 0) {
    console.warn(`  WARNINGS:`);
    for (const warn of result.warnings) {
      console.warn(`    ⚠️  ${warn}`);
    }
    console.warn("");
  }

  console.log(`${"=".repeat(60)}\n`);
}

/**
 * Validate config and exit with error if invalid
 * This should be called early in gateway startup
 */
export function validateConfigOrDie(configPath: string): any {
  const result = validateConfigFile(configPath);
  logConfigValidation(result);

  if (!result.valid) {
    console.error(`❌ Gateway cannot start: Config validation failed`);
    console.error(`   Fix the errors above and restart the gateway.`);
    console.error(`   Docs: https://docs.openclaw.ai/troubleshooting#config\n`);
    process.exit(1);
  }

  return result.config;
}
