// Debug script to find why accounts is unsupported
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

console.log("Telegram accounts schema keys:", Object.keys(telegramAccounts));
console.log("\nHas propertyNames:", !!telegramAccounts.propertyNames);
console.log("Has additionalProperties:", !!telegramAccounts.additionalProperties);

// Check additionalProperties structure
const additionalProps = telegramAccounts.additionalProperties;
console.log("\nAdditionalProperties keys:", Object.keys(additionalProps));
console.log("AdditionalProperties type:", additionalProps.type);

// Check if additionalProperties has anyOf/oneOf/allOf
console.log("\nChecking for union types in additionalProperties:");
console.log("  anyOf:", !!additionalProps.anyOf);
console.log("  oneOf:", !!additionalProps.oneOf);
console.log("  allOf:", !!additionalProps.allOf);

// Check properties
const props = additionalProps.properties || {};
console.log("\nProperties count:", Object.keys(props).length);

// Find properties with anyOf
for (const [key, value] of Object.entries(props)) {
  const schema = value as any;
  if (schema.anyOf || schema.oneOf || schema.allOf) {
    console.log(`\nProperty "${key}" has union type:`);
    console.log("  anyOf:", !!schema.anyOf);
    console.log("  oneOf:", !!schema.oneOf);
    console.log("  allOf:", !!schema.allOf);
  }
}
