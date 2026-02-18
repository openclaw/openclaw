/**
 * Houdini Claw - Annotation Generator
 *
 * Takes raw crawled documentation and generates structured annotations
 * using a high-reasoning AI model (GPT-5.2 xhigh or equivalent).
 *
 * Usage:
 *   bun src/houdini-claw/annotate.ts --input /tmp/houdini-raw/ --output /tmp/houdini-annotated/
 *   bun src/houdini-claw/annotate.ts --node pyro_solver --force
 */

import fs from "node:fs";
import path from "node:path";
import type { ParsedNodeDoc } from "./crawl.js";

// ── Types ──────────────────────────────────────────────────

interface AnnotationRequest {
  nodeName: string;
  system: string;
  rawDoc: string;
  sourceUrl: string;
  /** Structured parameter data from DOM parsing (when available). */
  parsedDoc?: ParsedNodeDoc;
}

interface AnnotationResult {
  nodeName: string;
  system: string;
  annotation: NodeAnnotation;
  sourceUrls: string[];
  annotatedAt: string;
  model: string;
}

interface NodeAnnotation {
  semantic_name_zh: string;
  semantic_name_en: string;
  one_line: string;
  analogy: string;
  prerequisite_nodes: string[];
  required_context: string;
  typical_network: string;
  parameters: ParameterAnnotationData[];
  recipes: RecipeData[];
  error_patterns: ErrorPatternData[];
}

interface ParameterAnnotationData {
  name: string;
  path: string;
  semantic_name_zh: string;
  semantic_name_en: string;
  one_line: string;
  intent_mapping: Record<string, string>;
  default_value: number;
  safe_range: [number, number];
  expert_range: [number, number];
  danger_zone: { below: number; above: number; description: string };
  visual_effect: Record<string, string>;
  interactions: Array<{
    param: string;
    relationship: string;
    warning?: string;
    tip?: string;
  }>;
  context_adjustments: Record<string, string>;
}

interface RecipeData {
  name: string;
  tags: string[];
  description: string;
  parameters: Record<string, Record<string, unknown>>;
  prerequisites: string[];
  warnings: string[];
  variations: Record<string, Record<string, unknown>>;
}

interface ErrorPatternData {
  pattern_id: string;
  symptoms: string[];
  root_causes: Array<{
    cause: string;
    probability: string;
    explanation: string;
    fix: string[];
    verify: string;
  }>;
}

// ── Annotation Prompt ──────────────────────────────────────

function buildAnnotationPrompt(request: AnnotationRequest): string {
  // Build structured parameter list if parsedDoc is available
  let parameterSection = "";
  if (request.parsedDoc && request.parsedDoc.parameters.length > 0) {
    const paramLines = request.parsedDoc.parameters.map(
      (p) => `- **${p.label}** (${p.folder}): ${p.description || "No description"}`,
    );
    parameterSection = `
## Extracted Parameters (${request.parsedDoc.parameters.length} found):
${paramLines.join("\n")}

IMPORTANT: The above parameter list was extracted via DOM parsing. Use it as a complete
reference for which parameters exist on this node. Annotate ALL important parameters
from this list, not just those mentioned in the raw text.
`;
  }

  // Include related nodes if available
  let relatedSection = "";
  if (request.parsedDoc && request.parsedDoc.relatedNodes.length > 0) {
    relatedSection = `
## Related Nodes (from page links):
${request.parsedDoc.relatedNodes.join(", ")}
`;
  }

  return `You are a senior Houdini Technical Director. Based on the following official documentation, generate a comprehensive structured annotation for the "${request.nodeName}" node.

System category: ${request.system}
Source URL: ${request.sourceUrl}
${parameterSection}${relatedSection}
## Raw Documentation:
${request.rawDoc}

## Output Requirements

Output valid JSON (not YAML) with the following structure. Be thorough and precise:

{
  "semantic_name_zh": "Chinese semantic name for this node",
  "semantic_name_en": "English semantic name (more descriptive than the code name)",
  "one_line": "One sentence explaining what this node does",
  "analogy": "A physical/everyday analogy that helps understand this node's purpose",
  "prerequisite_nodes": ["list of nodes that must exist upstream"],
  "required_context": "DOP/SOP/VOP/etc context where this node lives",
  "typical_network": "Description of how this node is typically connected in a network",
  "parameters": [
    {
      "name": "parameter_name",
      "path": "full/parameter/path",
      "semantic_name_zh": "Chinese semantic name",
      "semantic_name_en": "English semantic name",
      "one_line": "What this parameter controls",
      "intent_mapping": {
        "user wants X": "increase/decrease this parameter",
        "user wants Y": "set to specific value"
      },
      "default_value": 0.1,
      "safe_range": [min, max],
      "expert_range": [min, max],
      "danger_zone": {
        "below": value,
        "above": value,
        "description": "What happens in the danger zone"
      },
      "visual_effect": {
        "0.01": "Description of visual at this value",
        "0.1": "Description of visual at this value",
        "1.0": "Description of visual at this value"
      },
      "interactions": [
        {
          "param": "other_parameter_name",
          "relationship": "How they interact",
          "warning": "When combined effects are dangerous",
          "tip": "Useful combination advice"
        }
      ],
      "context_adjustments": {
        "indoor": "Recommended range and reasoning for indoor scenes",
        "outdoor": "Recommended range and reasoning for outdoor scenes",
        "large_scale": "Adjustments for large-scale sims",
        "stylized": "Adjustments for non-realistic styles"
      }
    }
  ],
  "recipes": [
    {
      "name": "Recipe Name",
      "tags": ["tag1", "tag2"],
      "description": "When to use this recipe",
      "parameters": { "node_name": { "param": "value" } },
      "prerequisites": ["What must be set up first"],
      "warnings": ["Common mistakes with this setup"],
      "variations": { "variation_name": { "param": "value", "note": "why" } }
    }
  ],
  "error_patterns": [
    {
      "pattern_id": "SYSTEM-NNN",
      "symptoms": ["What the user sees/reports"],
      "root_causes": [
        {
          "cause": "Root cause description",
          "probability": "high/medium/low",
          "explanation": "Technical explanation",
          "fix": ["Step 1", "Step 2"],
          "verify": "How to verify the fix worked"
        }
      ]
    }
  ]
}

Focus on:
1. Making parameter names human-readable (semantic naming)
2. Providing actionable ranges, not just descriptions
3. Mapping user intents to parameter adjustments
4. Warning about dangerous parameter interactions
5. Including at least 2-3 recipes per node
6. Including common error patterns specific to this node

Only include parameters that are important and commonly adjusted. Skip trivial or rarely-used parameters.`;
}

// ── Annotation Generation ──────────────────────────────────

/**
 * Generate a structured annotation for a Houdini node using the AI model.
 */
export async function annotateNode(
  request: AnnotationRequest,
  options?: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    thinking?: string;
  },
): Promise<AnnotationResult> {
  const model = options?.model ?? process.env.HOUDINI_CLAW_ANNOTATION_MODEL ?? "gpt-4o";
  const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = options?.baseUrl ?? "https://api.openai.com/v1";

  if (!apiKey) {
    throw new Error("No API key for annotation. Set OPENAI_API_KEY.");
  }

  const prompt = buildAnnotationPrompt(request);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a Houdini Technical Director expert. Output valid JSON only, no markdown fences.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3, // Low temperature for consistency
      max_tokens: 8000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Annotation API error ${response.status}: ${body}`);
  }

  const result = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const annotationJson = result.choices[0].message.content;
  const annotation = JSON.parse(annotationJson) as NodeAnnotation;

  return {
    nodeName: request.nodeName,
    system: request.system,
    annotation,
    sourceUrls: [request.sourceUrl],
    annotatedAt: new Date().toISOString(),
    model,
  };
}

/**
 * Process all crawled pages in a directory and generate annotations.
 */
export async function annotateAll(options: {
  inputDir: string;
  outputDir: string;
  model?: string;
  apiKey?: string;
  force?: boolean;
  onProgress?: (done: number, total: number, nodeName: string) => void;
}): Promise<{ annotated: number; errors: number; skipped: number }> {
  const { inputDir, outputDir } = options;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const files = fs.readdirSync(inputDir).filter((f: string) => f.endsWith(".json"));
  let annotated = 0;
  let errors = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const outputFile = path.join(outputDir, file);

    // Skip if already annotated (unless force)
    if (!options.force && fs.existsSync(outputFile)) {
      skipped++;
      options.onProgress?.(annotated + errors + skipped, files.length, file);
      continue;
    }

    try {
      const rawData = JSON.parse(
        fs.readFileSync(path.join(inputDir, file), "utf-8"),
      ) as {
        nodeName: string;
        url: string;
        content: string;
        parsedDoc?: ParsedNodeDoc;
      };

      // Extract system from filename (format: system--nodename.json)
      const system = file.split("--")[0];

      const result = await annotateNode(
        {
          nodeName: rawData.nodeName ?? file.replace(".json", ""),
          system,
          rawDoc: rawData.content,
          sourceUrl: rawData.url,
          parsedDoc: rawData.parsedDoc,
        },
        {
          model: options.model,
          apiKey: options.apiKey,
        },
      );

      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
      annotated++;
    } catch (err) {
      console.error(`[annotate] Failed for ${file}:`, (err as Error).message);
      errors++;
    }

    options.onProgress?.(annotated + errors + skipped, files.length, file);

    // Rate limit
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return { annotated, errors, skipped };
}

// ── CLI Entry Point ────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const modelIdx = args.indexOf("--model");
  const force = args.includes("--force");
  const nodeIdx = args.indexOf("--node");

  if (nodeIdx !== -1) {
    // Single node annotation
    const nodeName = args[nodeIdx + 1];
    console.log(`[annotate] Annotating single node: ${nodeName}`);
    // Implementation would read the crawled data for this specific node
  } else {
    const inputDir = inputIdx !== -1 ? args[inputIdx + 1] : "/tmp/houdini-raw";
    const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : "/tmp/houdini-annotated";
    const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

    console.log(`[annotate] Processing ${inputDir} → ${outputDir}`);

    annotateAll({
      inputDir,
      outputDir,
      model,
      force,
      onProgress: (done, total, name) => {
        console.log(`[annotate] ${done}/${total}: ${name}`);
      },
    }).then((result) => {
      console.log(
        `[annotate] Done. Annotated: ${result.annotated}, Errors: ${result.errors}, Skipped: ${result.skipped}`,
      );
    });
  }
}
