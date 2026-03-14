// Test script to analyze Telegram accounts schema specifically
import { analyzeConfigSchema } from "./ui/src/ui/views/config-form.analyze.js";

const telegramAccountsSchema = {
  "type": "object",
  "propertyNames": {
    "type": "string"
  },
  "additionalProperties": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean"
      },
      "commands": {
        "type": "object",
        "properties": {
          "native": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "string",
                "const": "auto"
              }
            ]
          }
        },
        "additionalProperties": false
      }
    },
    "required": [
      "dmPolicy",
      "groupPolicy"
    ],
    "additionalProperties": false
  }
};

console.log("Analyzing Telegram accounts schema...");
const result = analyzeConfigSchema(telegramAccountsSchema);
console.log("Result:", JSON.stringify(result, null, 2));
