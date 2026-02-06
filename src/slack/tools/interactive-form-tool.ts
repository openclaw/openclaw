/**
 * MCP tool for collecting form data via Slack Block Kit inputs
 * Uses input blocks for text/number fields and waits for user submission
 */

import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { SlackBlock } from "../blocks/types.js";
import { jsonResult } from "../../agents/tools/common.js";
import {
  header,
  section,
  divider,
  actions,
  button,
  input,
  textInput,
  emailInput,
  numberInput,
  staticSelect,
  option,
} from "../blocks/builders.js";
import { globalHandlerRegistry } from "../blocks/interactive.js";
import { sendMessageSlack } from "../send.js";
import { globalResponseStore } from "./response-store.js";

const FieldType = Type.Unsafe<string>({
  type: "string",
  enum: ["text", "multiline", "email", "number", "select"],
});

const FormFieldSchema = Type.Object({
  label: Type.String({ description: "Label shown above the input field" }),
  name: Type.String({ description: "Field name for the returned data (e.g., 'email', 'name')" }),
  type: FieldType,
  placeholder: Type.Optional(Type.String({ description: "Placeholder text" })),
  hint: Type.Optional(Type.String({ description: "Helper text below the field" })),
  required: Type.Optional(
    Type.Boolean({
      description: "Whether the field is required (default: true)",
      default: true,
    }),
  ),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ description: "Display text" }),
        value: Type.String({ description: "Value to return" }),
      }),
      { description: "Options for select fields" },
    ),
  ),
});

const InteractiveFormInput = Type.Object({
  to: Type.String({
    description:
      "Recipient: Slack channel (e.g., '#general') or user (e.g., '@username' or user ID)",
  }),
  title: Type.String({
    description: "Form title displayed at the top",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional description shown below the title",
    }),
  ),
  fields: Type.Array(FormFieldSchema, {
    description: "Form fields to collect (1-10 fields)",
    minItems: 1,
    maxItems: 10,
  }),
  submitLabel: Type.Optional(
    Type.String({
      description: "Label for the submit button (default: 'Submit')",
      default: "Submit",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "How long to wait for submission before timing out (default: 300 seconds / 5 minutes)",
      default: 300,
      minimum: 10,
      maximum: 3600,
    }),
  ),
  threadTs: Type.Optional(
    Type.String({
      description: "Optional thread timestamp to send form in a thread",
    }),
  ),
});

interface InteractiveFormToolOpts {
  accountId?: string;
  sessionKey?: string;
}

export function createSlackInteractiveFormTool(opts: InteractiveFormToolOpts = {}): AnyAgentTool {
  return {
    name: "AskSlackForm",
    label: "Ask Slack Form",
    parameters: InteractiveFormInput,
    description: `Collect structured data from a Slack user via a form and WAIT for submission.

This tool sends a form with input fields (text, email, number, select) and blocks execution until the user submits or the timeout expires.

Use cases:
- Collect multiple pieces of information at once
- Gather user details (name, email, preferences)
- Create structured data entry workflows

Field types:
- text: Single-line text input
- multiline: Multi-line text area
- email: Email input with validation
- number: Numeric input
- select: Dropdown selection (requires options array)

The tool returns all field values as a key-value object on submission.

Note: This tool BLOCKS until submitted or timeout. Use appropriate timeout values.`,
    execute: async (_toolCallId, args) => {
      const {
        to,
        title,
        description,
        fields,
        submitLabel = "Submit",
        timeoutSeconds = 300,
        threadTs,
      } = args;

      // Generate unique form ID
      const formId = crypto.randomBytes(16).toString("hex");
      const actionIdPrefix = `form_${formId}`;

      // Build form blocks
      const blocks: SlackBlock[] = [];

      blocks.push(header(title, `${actionIdPrefix}_header`));

      if (description) {
        blocks.push(section({ text: description, blockId: `${actionIdPrefix}_description` }));
        blocks.push(divider());
      }

      // Track field name to actionId mapping
      const fieldMapping: Map<string, { name: string; actionId: string; blockId: string }> =
        new Map();

      for (const field of fields) {
        const fieldActionId = `${actionIdPrefix}_field_${field.name}`;
        const fieldBlockId = `${actionIdPrefix}_block_${field.name}`;

        fieldMapping.set(fieldBlockId, {
          name: field.name,
          actionId: fieldActionId,
          blockId: fieldBlockId,
        });

        let element;
        switch (field.type) {
          case "text":
            element = textInput({
              actionId: fieldActionId,
              placeholder: field.placeholder,
            });
            break;

          case "multiline":
            element = textInput({
              actionId: fieldActionId,
              placeholder: field.placeholder,
              multiline: true,
            });
            break;

          case "email":
            element = emailInput({
              actionId: fieldActionId,
              placeholder: field.placeholder,
            });
            break;

          case "number":
            element = numberInput({
              actionId: fieldActionId,
              isDecimalAllowed: true,
              placeholder: field.placeholder,
            });
            break;

          case "select":
            if (!field.options || field.options.length === 0) {
              return jsonResult({
                submitted: false,
                error: `Select field "${field.label}" must have options`,
              });
            }
            element = staticSelect({
              actionId: fieldActionId,
              options: field.options.map((opt: { text: string; value: string }) =>
                option(opt.text, opt.value),
              ),
              placeholder: field.placeholder,
            });
            break;

          default:
            return jsonResult({
              submitted: false,
              error: `Unknown field type: ${String(field.type)}`,
            });
        }

        blocks.push(
          input({
            label: field.label,
            element,
            blockId: fieldBlockId,
            hint: field.hint,
            optional: field.required === false,
          }),
        );
      }

      // Add submit button
      const submitActionId = `${actionIdPrefix}_submit`;
      blocks.push(
        actions(
          [
            button({
              text: submitLabel,
              actionId: submitActionId,
              value: "submit",
              style: "primary",
            }),
          ],
          `${actionIdPrefix}_actions`,
        ),
      );

      // Register handler for form submission
      const responsePromise = globalResponseStore.waitForResponse(formId, timeoutSeconds * 1000);

      globalHandlerRegistry.register(new RegExp(`^${submitActionId}$`), async (params) => {
        // Extract form values from state
        const formValues: Record<string, string | number | null> = {};

        // The state.values is structured as: { block_id: { action_id: { value, ... } } }
        const stateValues = params.payload.state?.values ?? {};

        for (const [blockId, mapping] of fieldMapping) {
          const blockState = stateValues[blockId];
          if (blockState) {
            const fieldState = blockState[mapping.actionId] as
              | {
                  value?: string;
                  selected_option?: { value: string };
                }
              | undefined;

            if (fieldState) {
              // Handle different input types
              if (fieldState.selected_option) {
                formValues[mapping.name] = fieldState.selected_option.value;
              } else if (fieldState.value !== undefined) {
                formValues[mapping.name] = fieldState.value;
              } else {
                formValues[mapping.name] = null;
              }
            }
          }
        }

        // Record response
        globalResponseStore.recordResponse(formId, {
          answered: true,
          selectedValues: Object.values(formValues).filter((v) => v !== null) as string[],
          userId: params.userId,
          userName: params.userName,
          timestamp: Date.now(),
          // Store form values in a way we can retrieve them
          // We'll use a custom extension to the response
        });

        // Store form values separately for retrieval
        formDataStore.set(formId, formValues);

        // Unregister handler
        globalHandlerRegistry.unregister(new RegExp(`^${submitActionId}$`));
      });

      try {
        // Send the form
        const result = await sendMessageSlack(to, `📝 ${title}`, {
          blocks,
          threadTs,
          accountId: opts.accountId,
        });

        // Wait for response
        const response = await responsePromise;

        // Get form data
        const formData = formDataStore.get(formId);
        formDataStore.delete(formId);

        if (!response) {
          return jsonResult({
            submitted: false,
            timedOut: true,
            error: "No response received (internal error)",
          });
        }

        if (response.timedOut) {
          return jsonResult({
            submitted: false,
            timedOut: true,
            messageId: result.messageId,
            channelId: result.channelId,
          });
        }

        return jsonResult({
          submitted: true,
          values: formData ?? {},
          respondedBy: response.userId,
          respondedByName: response.userName,
          messageId: result.messageId,
          channelId: result.channelId,
          timedOut: false,
        });
      } catch (error) {
        // Clean up on error
        globalResponseStore.cancel(formId);
        globalHandlerRegistry.unregister(new RegExp(`^${submitActionId}$`));
        formDataStore.delete(formId);

        return jsonResult({
          submitted: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// Store form data separately since QuestionResponse doesn't have a formValues field
const formDataStore = new Map<string, Record<string, string | number | null>>();
