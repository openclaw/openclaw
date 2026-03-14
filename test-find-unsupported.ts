// Find which field causes <root> to be unsupported
import { OpenClawSchema } from "./src/config/zod-schema.js";
import { analyzeConfigSchema } from "./ui/src/ui/views/config-form.analyze.js";

const fullSchema = OpenClawSchema.toJSONSchema({
  target: "draft-07",
  unrepresentable: "any",
});

const channels = (fullSchema as any).properties?.channels;
const telegram = channels?.properties?.telegram;
const telegramAccounts = telegram?.properties?.accounts;
const additionalProps = telegramAccounts.additionalProperties;
const props = additionalProps.properties || {};

console.log("Testing each property...\n");

for (const [key, value] of Object.entries(props)) {
  const result = analyzeConfigSchema(value as any);
  if (result.unsupportedPaths.length > 0) {
    console.log(`❌ "${key}" has unsupported paths:`, result.unsupportedPaths);
  }
}

console.log("\nDone!");
