import MarkdownIt from "markdown-it";

type ListState = {
  type: "bullet" | "ordered";
  index: number;
};

type RenderEnv = {
  slackListStack?: ListState[];
  slackLinkStack?: { href: string }[];
};

const md = new MarkdownIt({
  html: false,
  // Slack will auto-link plain URLs; keeping linkify off avoids double-rendering
  // (e.g. "https://x.com" becoming "https://x.com (https://x.com)").
  linkify: false,
  breaks: false,
  typographer: false,
});

md.enable("strikethrough");

/**
 * Escape special characters for Slack mrkdwn format.
 *
 * By default, Slack uses angle-bracket markup for mentions and links
 * (e.g. "<@U123>", "<https://…|text>"). We preserve those tokens so agents
 * can intentionally include them, while escaping other uses of "<" and ">".
 */
function escapeSlackMrkdwnSegment(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) return false;
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

function escapeSlackMrkdwnText(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(
      isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token),
    );
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function getListStack(env: RenderEnv): ListState[] {
  if (!env.slackListStack) env.slackListStack = [];
  return env.slackListStack;
}

function getLinkStack(env: RenderEnv): { href: string }[] {
  if (!env.slackLinkStack) env.slackLinkStack = [];
  return env.slackLinkStack;
}

md.renderer.rules.text = (tokens, idx) =>
  escapeSlackMrkdwnText(tokens[idx]?.content ?? "");

md.renderer.rules.softbreak = () => "\n";
md.renderer.rules.hardbreak = () => "\n";

md.renderer.rules.paragraph_open = () => "";
md.renderer.rules.paragraph_close = (_tokens, _idx, _opts, env) => {
  const stack = getListStack(env as RenderEnv);
  return stack.length ? "" : "\n\n";
};

md.renderer.rules.heading_open = () => "*";
md.renderer.rules.heading_close = () => "*\n\n";

md.renderer.rules.blockquote_open = () => "> ";
md.renderer.rules.blockquote_close = () => "\n";

md.renderer.rules.bullet_list_open = (_tokens, _idx, _opts, env) => {
  getListStack(env as RenderEnv).push({ type: "bullet", index: 0 });
  return "";
};
md.renderer.rules.bullet_list_close = (_tokens, _idx, _opts, env) => {
  getListStack(env as RenderEnv).pop();
  return "";
};
md.renderer.rules.ordered_list_open = (tokens, idx, _opts, env) => {
  const start = Number(tokens[idx]?.attrGet("start") ?? "1");
  getListStack(env as RenderEnv).push({ type: "ordered", index: start - 1 });
  return "";
};
md.renderer.rules.ordered_list_close = (_tokens, _idx, _opts, env) => {
  getListStack(env as RenderEnv).pop();
  return "";
};
md.renderer.rules.list_item_open = (_tokens, _idx, _opts, env) => {
  const stack = getListStack(env as RenderEnv);
  const top = stack[stack.length - 1];
  if (!top) return "";
  top.index += 1;
  const indent = "  ".repeat(Math.max(0, stack.length - 1));
  const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
  return `${indent}${prefix}`;
};
md.renderer.rules.list_item_close = () => "\n";

// Slack mrkdwn uses _text_ for italic (same as markdown)
md.renderer.rules.em_open = () => "_";
md.renderer.rules.em_close = () => "_";

// Slack mrkdwn uses *text* for bold (single asterisk, not double)
md.renderer.rules.strong_open = () => "*";
md.renderer.rules.strong_close = () => "*";

// Slack mrkdwn uses ~text~ for strikethrough (single tilde)
md.renderer.rules.s_open = () => "~";
md.renderer.rules.s_close = () => "~";

md.renderer.rules.code_inline = (tokens, idx) =>
  `\`${escapeSlackMrkdwnSegment(tokens[idx]?.content ?? "")}\``;

md.renderer.rules.code_block = (tokens, idx) =>
  `\`\`\`\n${escapeSlackMrkdwnSegment(tokens[idx]?.content ?? "")}\`\`\`\n`;

md.renderer.rules.fence = (tokens, idx) =>
  `\`\`\`\n${escapeSlackMrkdwnSegment(tokens[idx]?.content ?? "")}\`\`\`\n`;

md.renderer.rules.link_open = (tokens, idx, _opts, env) => {
  const href = tokens[idx]?.attrGet("href") ?? "";
  const stack = getLinkStack(env as RenderEnv);
  stack.push({ href });
  return "";
};
md.renderer.rules.link_close = (_tokens, _idx, _opts, env) => {
  const stack = getLinkStack(env as RenderEnv);
  const link = stack.pop();
  if (link?.href) {
    return ` (${escapeSlackMrkdwnSegment(link.href)})`;
  }
  return "";
};

md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx]?.content ?? "";
  return escapeSlackMrkdwnSegment(alt);
};

md.renderer.rules.html_block = (tokens, idx) =>
  escapeSlackMrkdwnSegment(tokens[idx]?.content ?? "");
md.renderer.rules.html_inline = (tokens, idx) =>
  escapeSlackMrkdwnSegment(tokens[idx]?.content ?? "");

md.renderer.rules.table_open = () => "";
md.renderer.rules.table_close = () => "";
md.renderer.rules.thead_open = () => "";
md.renderer.rules.thead_close = () => "";
md.renderer.rules.tbody_open = () => "";
md.renderer.rules.tbody_close = () => "";
md.renderer.rules.tr_open = () => "";
md.renderer.rules.tr_close = () => "\n";
md.renderer.rules.th_open = () => "";
md.renderer.rules.th_close = () => "\t";
md.renderer.rules.td_open = () => "";
md.renderer.rules.td_close = () => "\t";

md.renderer.rules.hr = () => "\n";

function protectSlackAngleLinks(markdown: string): {
  markdown: string;
  tokens: string[];
} {
  const tokens: string[] = [];
  const protectedMarkdown = (markdown ?? "").replace(
    /<(?:https?:\/\/|mailto:|tel:|slack:\/\/)[^>\n]+>/g,
    (match) => {
      const id = tokens.length;
      tokens.push(match);
      return `⟦clawdbot-slacktok:${id}⟧`;
    },
  );
  return { markdown: protectedMarkdown, tokens };
}

function restoreSlackAngleLinks(text: string, tokens: string[]): string {
  let out = text;
  for (let i = 0; i < tokens.length; i++) {
    out = out.replaceAll(`⟦clawdbot-slacktok:${i}⟧`, tokens[i] ?? "");
  }
  return out;
}

/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Slack mrkdwn differences from standard Markdown:
 * - Bold: *text* (single asterisk, not double)
 * - Italic: _text_ (same)
 * - Strikethrough: ~text~ (single tilde)
 * - Code: `code` (same)
 * - Links: <url|text> or plain URL
 * - Escape &, <, > as &amp;, &lt;, &gt;
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  const env: RenderEnv = {};
  const protectedLinks = protectSlackAngleLinks(markdown ?? "");
  const rendered = md.render(protectedLinks.markdown, env);
  const normalized = rendered
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\t+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return restoreSlackAngleLinks(normalized, protectedLinks.tokens);
}
