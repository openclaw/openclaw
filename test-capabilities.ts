// Debug capabilities schema
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

const capabilities = props.capabilities;
console.log("Capabilities schema:");
console.log(JSON.stringify(capabilities, null, 2));

console.log("\nAnalyzing capabilities...");
const result = analyzeConfigSchema(capabilities);
console.log("Result:", JSON.stringify(result, null, 2));
