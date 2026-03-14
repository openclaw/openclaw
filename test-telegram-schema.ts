// Test script to compare Telegram and WhatsApp accounts schemas
import { OpenClawSchema } from "./src/config/zod-schema.js";

const schema = OpenClawSchema.toJSONSchema({
  target: "draft-07",
  unrepresentable: "any",
});

// Navigate to channels
const channels = schema.properties?.channels as any;

// Get Telegram accounts
const telegram = channels?.properties?.telegram as any;
const telegramAccounts = telegram?.properties?.accounts;

// Get WhatsApp accounts  
const whatsapp = channels?.properties?.whatsapp as any;
const whatsappAccounts = whatsapp?.properties?.accounts;

console.log("=== Telegram Accounts Schema ===");
console.log(JSON.stringify(telegramAccounts, null, 2));

console.log("\n=== WhatsApp Accounts Schema ===");
console.log(JSON.stringify(whatsappAccounts, null, 2));

// Check for anyOf/oneOf/allOf
console.log("\n=== Checking for union types ===");
console.log("Telegram has anyOf:", JSON.stringify(telegramAccounts).includes('"anyOf"'));
console.log("Telegram has oneOf:", JSON.stringify(telegramAccounts).includes('"oneOf"'));
console.log("Telegram has allOf:", JSON.stringify(telegramAccounts).includes('"allOf"'));
console.log("WhatsApp has anyOf:", JSON.stringify(whatsappAccounts).includes('"anyOf"'));
console.log("WhatsApp has oneOf:", JSON.stringify(whatsappAccounts).includes('"oneOf"'));
console.log("WhatsApp has allOf:", JSON.stringify(whatsappAccounts).includes('"allOf"'));
