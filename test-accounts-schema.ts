// Test script to analyze accounts schema structure
import { OpenClawSchema } from "./src/config/zod-schema.js";

const schema = OpenClawSchema.toJSONSchema({
  target: "draft-07",
  unrepresentable: "any",
});

// Navigate to channels.whatsapp.accounts
const channels = schema.properties?.channels as any;
const whatsapp = channels?.properties?.whatsapp as any;
const accounts = whatsapp?.properties?.accounts as any;

console.log("Accounts schema structure:");
console.log(JSON.stringify(accounts, null, 2));
