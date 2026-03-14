// Debug why accounts is still unsupported
import { OpenClawSchema } from "./src/config/zod-schema.js";
import { analyzeConfigSchema } from "./ui/src/ui/views/config-form.analyze.js";

const fullSchema = OpenClawSchema.toJSONSchema({
  target: "draft-07",
  unrepresentable: "any",
});

const channels = (fullSchema as any).properties?.channels;
const telegram = channels?.properties?.telegram;
const telegramAccounts = telegram?.properties?.accounts;

console.log("Analyzing Telegram accounts...");
const result = analyzeConfigSchema(telegramAccounts);

console.log("\n=== Result ===");
console.log("Schema normalized:", result.schema ? "YES" : "NO");
console.log("Unsupported paths:", result.unsupportedPaths);

// Check additionalProperties
if (result.schema) {
  const additionalProps = (result.schema as any).additionalProperties;
  console.log("\nAdditionalProperties has unsupported paths:", 
    additionalProps ? analyzeConfigSchema(additionalProps).unsupportedPaths : "N/A"
  );
}
