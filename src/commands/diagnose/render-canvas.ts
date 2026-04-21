import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

const CANVAS_FILENAME = "diagnostics.html";

/**
 * Wrap a Markdown report in a self-contained HTML page and write it to the
 * OpenClaw canvas directory (~/.openclaw/canvas/).
 *
 * Returns the absolute path of the written file.
 */
export async function renderCanvasHtml(markdown: string): Promise<string> {
  const stateDir = resolveStateDir();
  const canvasDir = path.join(stateDir, "canvas");
  await fs.mkdir(canvasDir, { recursive: true });

  const outputPath = path.join(canvasDir, CANVAS_FILENAME);
  const html = buildHtmlPage(markdown);
  await fs.writeFile(outputPath, html, "utf-8");
  return outputPath;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtmlPage(markdown: string): string {
  // The page includes a minimal Markdown-to-HTML renderer (inline JS) so it
  // is fully self-contained — no external dependencies required.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Gateway Diagnostic Report</title>
<style>
  :root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --text: #e0e0e0;
    --text-muted: #8888aa;
    --accent: #0f3460;
    --green: #4caf50;
    --yellow: #ffc107;
    --red: #f44336;
    --blue: #2196f3;
    --code-bg: #0d1117;
    --border: #2a2a4a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 24px 40px;
    max-width: 960px;
    margin: 0 auto;
  }
  h1 { color: var(--blue); margin-bottom: 16px; font-size: 1.6em; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  h2 { color: var(--green); margin-top: 28px; margin-bottom: 12px; font-size: 1.3em; }
  h3 { color: var(--yellow); margin-top: 20px; margin-bottom: 8px; font-size: 1.1em; }
  p { margin-bottom: 12px; }
  ul, ol { margin-bottom: 12px; padding-left: 24px; }
  li { margin-bottom: 4px; }
  code {
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.9em;
    font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
  }
  pre {
    background: var(--code-bg);
    padding: 12px 16px;
    border-radius: 6px;
    overflow-x: auto;
    margin-bottom: 16px;
    border: 1px solid var(--border);
  }
  pre code { background: none; padding: 0; }
  strong { color: #fff; }
  .toolbar {
    position: fixed;
    top: 12px;
    right: 24px;
    display: flex;
    gap: 8px;
    z-index: 100;
  }
  .toolbar button {
    background: var(--accent);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .toolbar button:hover { background: var(--blue); color: #fff; }
  .timestamp { color: var(--text-muted); font-size: 0.85em; }
</style>
</head>
<body>
<div class="toolbar">
  <button onclick="copyReport()">Copy Markdown</button>
  <button onclick="window.print()">Print</button>
</div>

<div id="report"></div>

<script>
// Minimal Markdown-to-HTML (covers headings, bold, code, lists, paragraphs).
function md2html(md) {
  var lines = md.split('\\n');
  var html = [];
  var inList = false;
  var inCode = false;
  var codeLang = '';
  var codeLines = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (inCode) {
      if (line.trimEnd() === '\`\`\`') {
        html.push('<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>');
        inCode = false;
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (line.startsWith('\`\`\`')) {
      if (inList) { html.push('</ul>'); inList = false; }
      inCode = true;
      codeLang = line.slice(3).trim();
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      if (inList) { html.push('</ul>'); inList = false; }
      var level = line.match(/^(#+)/)[1].length;
      html.push('<h' + level + '>' + inline(line.replace(/^#+\\s*/, '')) + '</h' + level + '>');
    } else if (/^[-*] /.test(line.trim())) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push('<li>' + inline(line.replace(/^\\s*[-*]\\s*/, '')) + '</li>');
    } else if (line.trim() === '') {
      if (inList) { html.push('</ul>'); inList = false; }
    } else {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push('<p>' + inline(line) + '</p>');
    }
  }
  if (inList) html.push('</ul>');
  if (inCode) html.push('<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>');
  return html.join('\\n');
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function inline(s) {
  // Escape HTML FIRST to prevent script injection from log/config content,
  // then apply markdown formatting on the safe escaped text.
  s = esc(s);
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  return s;
}

var rawMarkdown = ${JSON.stringify(markdown)};
document.getElementById('report').innerHTML = md2html(rawMarkdown);

function copyReport() {
  navigator.clipboard.writeText(rawMarkdown).then(function() {
    event.target.textContent = 'Copied!';
    setTimeout(function() { event.target.textContent = 'Copy Markdown'; }, 1500);
  });
}
</script>
</body>
</html>`;
}
