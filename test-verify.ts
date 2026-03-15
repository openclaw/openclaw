// Verify the fix: accounts should work, but complex unions should be unsupported
import { OpenClawSchema } from "./src/config/zod-schema.js";
import { analyzeConfigSchema } from "./ui/src/ui/views/config-form.analyze.js";

const fullSchema = OpenClawSchema.toJSONSchema({
  target: "draft-07",
  unrepresentable: "any",
});

console.log("Analyzing full schema...");
const result = analyzeConfigSchema(fullSchema);

console.log("\n=== Unsupported paths ===");
console.log("Total:", result.unsupportedPaths.length);
result.unsupportedPaths.forEach(p => console.log("  -", p));

// Check specific paths
const accountsPaths = result.unsupportedPaths.filter(p => p.includes("accounts"));
const capabilitiesPaths = result.unsupportedPaths.filter(p => p.includes("capabilities"));

console.log("\n=== Analysis ===");
console.log("Accounts paths unsupported:", accountsPaths.length > 0 ? accountsPaths : "None (GOOD - accounts work!)");
console.log("Capabilities paths unsupported:", capabilitiesPaths.length > 0 ? capabilitiesPaths : "None");

// Check if complex unions are properly marked
const complexUnionPaths = result.unsupportedPaths.filter(p => 
  p.includes("customCommands") || 
  p.includes("capabilities")
);
console.log("\nComplex unions (array|object) marked as unsupported:", complexUnionPaths.length > 0 ? "YES (correct)" : "NO");
