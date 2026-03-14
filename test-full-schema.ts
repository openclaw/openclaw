// Test script to analyze full schema with WhatsApp accounts
import { OpenClawSchema } from "./src/config/zod-schema.js";
import { analyzeConfigSchema } from "./ui/src/ui/views/config-form.analyze.js";

const fullSchema = OpenClawSchema.toJSONSchema({
  target: "draft-07",
  unrepresentable: "any",
});

console.log("Analyzing full schema...");
const result = analyzeConfigSchema(fullSchema);

// Check if accounts path is in unsupportedPaths
const accountsPaths = result.unsupportedPaths.filter(p => 
  p.includes("accounts") || p.includes("whatsapp")
);

console.log("\nAll unsupported paths:", result.unsupportedPaths);
console.log("\nAccounts/WhatsApp related unsupported paths:", accountsPaths);
console.log("\nTotal unsupported paths:", result.unsupportedPaths.length);
