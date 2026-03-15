// Test script to analyze accounts schema with UI analyzer
import { analyzeConfigSchema } from "./ui/src/ui/views/config-form.analyze.js";

const accountsSchema = {
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
      "dmPolicy": {
        "default": "pairing",
        "type": "string",
        "enum": [
          "pairing",
          "allowlist",
          "open",
          "disabled"
        ]
      }
    },
    "required": [
      "dmPolicy"
    ],
    "additionalProperties": false
  }
};

console.log("Analyzing accounts schema...");
const result = analyzeConfigSchema(accountsSchema);
console.log("Result:", JSON.stringify(result, null, 2));
