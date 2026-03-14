// Debug customCommands schema
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

const customCommands = props.customCommands;
console.log("CustomCommands schema:");
console.log(JSON.stringify(customCommands, null, 2));

console.log("\nAnalyzing customCommands...");
const result = analyzeConfigSchema(customCommands);
console.log("Result:", JSON.stringify(result, null, 2));
