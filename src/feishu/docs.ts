import type { Client } from "@larksuiteoapi/node-sdk";
import { getChildLogger } from "../logging.js";
import { resolveFeishuApiBase } from "./domain.js";

const logger = getChildLogger({ module: "feishu-docs" });

type FeishuApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type FeishuRequestClient = {
  request: <T>(params: {
    method: string;
    url: string;
    params?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }) => Promise<FeishuApiResponse<T>>;
};

/**
 * Document token info extracted from a Feishu/Lark document URL or message
 */
export type FeishuDocRef = {
  docToken: string;
  docType: "docx" | "doc" | "sheet" | "bitable" | "wiki" | "mindnote" | "file" | "slide";
  url: string;
  title?: string;
};

/**
 * Regex patterns to extract doc_token from various Feishu/Lark URLs
 *
 * Supported URL formats:
 * - https://xxx.feishu.cn/docx/xxxxx
 * - https://xxx.feishu.cn/wiki/xxxxx
 * - https://xxx.feishu.cn/sheets/xxxxx
 * - https://xxx.feishu.cn/base/xxxxx (bitable)
 * - https://xxx.larksuite.com/docx/xxxxx
 * etc.
 */
/* eslint-disable no-useless-escape */
const DOC_URL_PATTERNS = [
  // docx (new version document) - token is typically 22-27 chars
  /https?:\/\/[^\/]+\/(docx)\/([A-Za-z0-9_-]{15,35})/,
  // doc (legacy document)
  /https?:\/\/[^\/]+\/(doc)\/([A-Za-z0-9_-]{15,35})/,
  // wiki
  /https?:\/\/[^\/]+\/(wiki)\/([A-Za-z0-9_-]{15,35})/,
  // sheets
  /https?:\/\/[^\/]+\/(sheets?)\/([A-Za-z0-9_-]{15,35})/,
  // bitable (base)
  /https?:\/\/[^\/]+\/(base|bitable)\/([A-Za-z0-9_-]{15,35})/,
  // mindnote
  /https?:\/\/[^\/]+\/(mindnote)\/([A-Za-z0-9_-]{15,35})/,
  // file
  /https?:\/\/[^\/]+\/(file)\/([A-Za-z0-9_-]{15,35})/,
  // slide
  /https?:\/\/[^\/]+\/(slides?)\/([A-Za-z0-9_-]{15,35})/,
];
/* eslint-enable no-useless-escape */

/**
 * Extract document references from text content
 * Looks for Feishu/Lark document URLs and extracts doc tokens
 */
export function extractDocRefsFromText(text: string): FeishuDocRef[] {
  const refs: FeishuDocRef[] = [];
  const seenTokens = new Set<string>();

  for (const pattern of DOC_URL_PATTERNS) {
    const regex = new RegExp(pattern, "g");
    let match;
    while ((match = regex.exec(text)) !== null) {
      const [url, typeStr, token] = match;
      const docType = normalizeDocType(typeStr);

      if (!seenTokens.has(token)) {
        seenTokens.add(token);
        refs.push({
          docToken: token,
          docType,
          url,
        });
      }
    }
  }

  return refs;
}

/**
 * Extract document references from a rich text (post) message content
 */
export function extractDocRefsFromPost(content: unknown): FeishuDocRef[] {
  const refs: FeishuDocRef[] = [];
  const seenTokens = new Set<string>();

  try {
    // Post content structure: { title, content: [[{tag, ...}]] }
    const postContent = typeof content === "string" ? JSON.parse(content) : content;

    // Check title for links
    if (postContent.title) {
      const titleRefs = extractDocRefsFromText(postContent.title);
      for (const ref of titleRefs) {
        if (!seenTokens.has(ref.docToken)) {
          seenTokens.add(ref.docToken);
          refs.push(ref);
        }
      }
    }

    // Check content elements
    if (Array.isArray(postContent.content)) {
      for (const line of postContent.content) {
        if (!Array.isArray(line)) {
          continue;
        }

        for (const element of line) {
          // Check hyperlinks
          if (element.tag === "a" && element.href) {
            const linkRefs = extractDocRefsFromText(element.href);
            for (const ref of linkRefs) {
              if (!seenTokens.has(ref.docToken)) {
                seenTokens.add(ref.docToken);
                // Use the link text as title if available
                ref.title = element.text || undefined;
                refs.push(ref);
              }
            }
          }

          // Check text content for inline URLs
          if (element.tag === "text" && element.text) {
            const textRefs = extractDocRefsFromText(element.text);
            for (const ref of textRefs) {
              if (!seenTokens.has(ref.docToken)) {
                seenTokens.add(ref.docToken);
                refs.push(ref);
              }
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    logger.debug(`Failed to parse post content: ${String(err)}`);
  }

  return refs;
}

function normalizeDocType(
  typeStr: string,
): "docx" | "doc" | "sheet" | "bitable" | "wiki" | "mindnote" | "file" | "slide" {
  switch (typeStr.toLowerCase()) {
    case "docx":
      return "docx";
    case "doc":
      return "doc";
    case "sheet":
    case "sheets":
      return "sheet";
    case "base":
    case "bitable":
      return "bitable";
    case "wiki":
      return "wiki";
    case "mindnote":
      return "mindnote";
    case "file":
      return "file";
    case "slide":
    case "slides":
      return "slide";
    default:
      return "docx";
  }
}

/**
 * Get wiki node info to resolve the actual document token
 *
 * Wiki documents have a node_token that needs to be resolved to the actual obj_token
 *
 * API: GET https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node
 * Required permission: wiki:wiki:readonly or wiki:wiki
 */
async function resolveWikiNode(
  client: Client,
  nodeToken: string,
  apiBase: string,
): Promise<{ objToken: string; objType: string; title?: string } | null> {
  try {
    logger.debug(`Resolving wiki node: ${nodeToken}`);

    const response = await (client as FeishuRequestClient).request<{
      node?: { obj_token?: string; obj_type?: string; title?: string };
    }>({
      method: "GET",
      url: `${apiBase}/wiki/v2/spaces/get_node`,
      params: {
        token: nodeToken,
        obj_type: "wiki",
      },
    });

    if (response?.code !== 0) {
      const errMsg = response?.msg || "Unknown error";
      logger.warn(`Failed to resolve wiki node: ${errMsg} (code: ${response?.code})`);
      return null;
    }

    const node = response.data?.node;
    if (!node?.obj_token || !node?.obj_type) {
      logger.warn(`Wiki node response missing obj_token or obj_type`);
      return null;
    }

    return {
      objToken: node.obj_token,
      objType: node.obj_type,
      title: node.title,
    };
  } catch (err: unknown) {
    logger.error(`Error resolving wiki node: ${String(err)}`);
    return null;
  }
}

/**
 * Fetch the content of a Feishu document
 *
 * Supports:
 * - docx (new version documents) - direct content fetch
 * - wiki (knowledge base nodes) - first resolve to actual document, then fetch
 *
 * Other document types return a placeholder message.
 *
 * API: GET https://open.feishu.cn/open-apis/docs/v1/content
 * Docs: https://open.feishu.cn/document/server-docs/docs/content/get
 *
 * Required permissions:
 * - docs:document.content:read (for docx)
 * - wiki:wiki:readonly or wiki:wiki (for wiki)
 */
export async function fetchFeishuDocContent(
  client: Client,
  docRef: FeishuDocRef,
  options: {
    maxLength?: number;
    lang?: "zh" | "en" | "ja";
    apiBase?: string;
  } = {},
): Promise<{ content: string; truncated: boolean } | null> {
  const { maxLength = 50000, lang = "zh", apiBase } = options;
  const resolvedApiBase = apiBase ?? resolveFeishuApiBase();

  // For wiki type, first resolve the node to get the actual document token
  let targetToken = docRef.docToken;
  let targetType = docRef.docType;
  let resolvedTitle = docRef.title;

  if (docRef.docType === "wiki") {
    const wikiNode = await resolveWikiNode(client, docRef.docToken, resolvedApiBase);
    if (!wikiNode) {
      return {
        content: `[Feishu Wiki Document: ${docRef.title || docRef.docToken}]\nLink: ${docRef.url}\n\n(Unable to access wiki node info. Please ensure the bot has been added as a wiki space member)`,
        truncated: false,
      };
    }

    targetToken = wikiNode.objToken;
    targetType = wikiNode.objType as FeishuDocRef["docType"];
    resolvedTitle = wikiNode.title || docRef.title;

    logger.debug(`Wiki node resolved: ${docRef.docToken} -> ${targetToken} (${targetType})`);
  }

  // Only docx is supported for content fetching
  if (targetType !== "docx") {
    logger.debug(`Document type ${targetType} is not supported for content fetching`);
    return {
      content: `[Feishu ${getDocTypeName(targetType)} Document: ${resolvedTitle || targetToken}]\nLink: ${docRef.url}\n\n(This document type does not support content extraction. Please access the link directly)`,
      truncated: false,
    };
  }

  try {
    logger.debug(`Fetching document content: ${targetToken} (${targetType})`);

    // Use native HTTP request since SDK may not have this endpoint
    // The API endpoint is: GET /open-apis/docs/v1/content
    const response = await (client as FeishuRequestClient).request<{
      content?: string;
    }>({
      method: "GET",
      url: `${resolvedApiBase}/docs/v1/content`,
      params: {
        doc_token: targetToken,
        doc_type: "docx",
        content_type: "markdown",
        lang,
      },
    });

    if (response?.code !== 0) {
      const errMsg = response?.msg || "Unknown error";
      logger.warn(`Failed to fetch document content: ${errMsg} (code: ${response?.code})`);

      // Check for common errors
      if (response?.code === 2889902) {
        return {
          content: `[Feishu Document: ${resolvedTitle || targetToken}]\nLink: ${docRef.url}\n\n(No permission to access this document. Please ensure the bot has been added as a document collaborator)`,
          truncated: false,
        };
      }

      return {
        content: `[Feishu Document: ${resolvedTitle || targetToken}]\nLink: ${docRef.url}\n\n(Failed to fetch document content: ${errMsg})`,
        truncated: false,
      };
    }

    let content = response.data?.content || "";
    let truncated = false;

    // Truncate if too long
    if (content.length > maxLength) {
      content = content.substring(0, maxLength) + "\n\n... (Content truncated due to length)";
      truncated = true;
    }

    // Add document header
    const header = resolvedTitle
      ? `[Feishu Document: ${resolvedTitle}]\nLink: ${docRef.url}\n\n---\n\n`
      : `[Feishu Document]\nLink: ${docRef.url}\n\n---\n\n`;

    return {
      content: header + content,
      truncated,
    };
  } catch (err: unknown) {
    logger.error(`Error fetching document content: ${String(err)}`);
    return {
      content: `[Feishu Document: ${resolvedTitle || targetToken}]\nLink: ${docRef.url}\n\n(Error occurred while fetching document content)`,
      truncated: false,
    };
  }
}

function getDocTypeName(docType: FeishuDocRef["docType"]): string {
  switch (docType) {
    case "docx":
    case "doc":
      return "";
    case "sheet":
      return "Sheet";
    case "bitable":
      return "Bitable";
    case "wiki":
      return "Wiki";
    case "mindnote":
      return "Mindnote";
    case "file":
      return "File";
    case "slide":
      return "Slide";
    default:
      return "";
  }
}

/**
 * Resolve document content from a message
 * Extracts document links and fetches their content
 *
 * @returns Combined document content string, or null if no documents found
 */
export async function resolveFeishuDocsFromMessage(
  client: Client,
  message: { message_type?: string; content?: string },
  options: {
    maxDocsPerMessage?: number;
    maxTotalLength?: number;
    domain?: string;
  } = {},
): Promise<string | null> {
  const { maxDocsPerMessage = 3, maxTotalLength = 100000 } = options;
  const apiBase = resolveFeishuApiBase(options.domain);

  const msgType = message.message_type;
  let docRefs: FeishuDocRef[] = [];

  try {
    const content = JSON.parse(message.content ?? "{}");

    if (msgType === "text" && content.text) {
      // Extract from plain text
      docRefs = extractDocRefsFromText(content.text);
    } else if (msgType === "post") {
      // Extract from rich text - handle locale wrapper
      let postData = content;
      if (content.post && typeof content.post === "object") {
        const localeKey = Object.keys(content.post).find(
          (key) => content.post[key]?.content || content.post[key]?.title,
        );
        if (localeKey) {
          postData = content.post[localeKey];
        }
      }
      docRefs = extractDocRefsFromPost(postData);
    }
    // TODO: Handle interactive (card) messages with document links
  } catch (err: unknown) {
    logger.debug(`Failed to parse message content for document extraction: ${String(err)}`);
    return null;
  }

  if (docRefs.length === 0) {
    return null;
  }

  // Limit number of documents to process
  const refsToProcess = docRefs.slice(0, maxDocsPerMessage);

  logger.debug(`Found ${docRefs.length} document(s), processing ${refsToProcess.length}`);

  const contents: string[] = [];
  let totalLength = 0;

  for (const ref of refsToProcess) {
    const result = await fetchFeishuDocContent(client, ref, {
      maxLength: Math.min(50000, maxTotalLength - totalLength),
      apiBase,
    });

    if (result) {
      contents.push(result.content);
      totalLength += result.content.length;

      if (totalLength >= maxTotalLength) {
        break;
      }
    }
  }

  if (contents.length === 0) {
    return null;
  }

  return contents.join("\n\n---\n\n");
}
