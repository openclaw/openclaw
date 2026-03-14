// Test script to analyze full Telegram accounts schema
import { OpenClawSchema } from "./src/config/zod-schema.js";
import { analyzeConfigSchema } from "./ui/src/ui/views/config-form.analyze.js";

const fullSchema = OpenClawSchema.toJSONSchema({
  target: "draft-07",
  unrepresentable: "any",
});

// Get Telegram accounts
const channels = (fullSchema as any).properties?.channels;
const telegram = channels?.properties?.telegram;
const telegramAccounts = telegram?.properties?.accounts;

console.log("Analyzing full Telegram accounts schema...");
const result = analyzeConfigSchema(telegramAccounts);
console.log("Unsupported paths:", result.unsupportedPaths);

// Check if the schema was normalized
if (result.schema) {
  console.log("Schema normalized successfully");
  // Check additionalProperties
  const additionalProps = (result.schema as any).additionalProperties;
  if (additionalProps) {
    console.log("AdditionalProperties type:", additionalProps.type);
    console.log("Has properties:", Object.keys(additionalProps.properties || {}).slice(0, 5));
  }
} else {
  console.log("Schema is null - not normalized");
}
