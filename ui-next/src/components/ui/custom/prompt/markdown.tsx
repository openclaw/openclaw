import { ExternalLink, FileText, X, ZoomIn } from "lucide-react";
import { marked } from "marked";
import React, { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CodeBlock, CodeBlockCode, MermaidBlock } from "./code-block";

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: Partial<Components>;
  /** Agent ID for converting workspace file paths to inline image URLs. */
  agentId?: string;
};

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map((token) => token.raw);
}

function extractLanguage(className?: string): string {
  if (!className) {
    return "plaintext";
  }
  const match = className.match(/language-(\w+)/);
  return match ? match[1] : "plaintext";
}

/** Convert heading children (React nodes) to a URL-safe anchor id */
function slugifyHeading(children: React.ReactNode): string {
  const text =
    typeof children === "string"
      ? children
      : Array.isArray(children)
        ? children.map((c) => (typeof c === "string" ? c : "")).join("")
        : "";
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Copy a section deep-link to clipboard, flash "✓" for 1.5 s */
function AnchorButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    void navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [id]);

  return (
    <button
      onClick={copy}
      className="ml-2 opacity-0 group-hover/h:opacity-100 text-primary/40 hover:text-primary transition-opacity text-sm font-mono font-normal leading-none"
      title={copied ? "Copied!" : "Copy link to section"}
      aria-label="Copy section link"
    >
      {copied ? "✓" : "#"}
    </button>
  );
}

/** Lightbox that fetches + renders a markdown file in a modal overlay. */
function MarkdownFileLightbox({
  url,
  fileName,
  onClose,
}: {
  url: string;
  fileName: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(url)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`${r.status}`);
        }
        return r.text();
      })
      .then(setContent)
      .catch(() => setError(true));
  }, [url]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in-0 duration-150"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-[90vw] max-h-[90vh] w-[800px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50 shrink-0">
          <span className="text-sm font-medium text-foreground truncate">{fileName}</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors shrink-0 ml-3"
          >
            <ExternalLink className="h-3 w-3" />
            Raw
          </a>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 prose prose-sm prose-chat max-w-none">
          {error && <p className="text-destructive text-sm">Failed to load file</p>}
          {content === null && !error && (
            <p className="text-muted-foreground text-sm animate-pulse">Loading...</p>
          )}
          {content !== null && <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>}
        </div>
      </div>
    </div>
  );
}

/** Clickable card for markdown files that opens a lightbox preview. */
function MarkdownFileCard({ src, fileName }: { src: string; fileName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-3 flex items-center gap-2.5 px-4 py-2.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 transition-colors cursor-pointer w-full text-left"
      >
        <FileText className="h-4 w-4 text-primary/60 shrink-0" />
        <span className="text-sm font-medium text-foreground truncate">{fileName}</span>
        <span className="ml-auto text-xs text-muted-foreground shrink-0">Preview</span>
      </button>
      {open && (
        <MarkdownFileLightbox url={src} fileName={fileName} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

const INITIAL_COMPONENTS: Partial<Components> = {
  // ── Code ──
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line;

    if (isInline) {
      return (
        <span
          className={cn(
            "bg-primary/10 text-primary/90 border border-primary/15 rounded px-1.5 py-0.5 font-mono text-[0.8em]",
            className,
          )}
          {...props}
        >
          {children}
        </span>
      );
    }

    const language = extractLanguage(className);

    if (language === "mermaid") {
      return <MermaidBlock code={children as string} />;
    }

    return (
      <CodeBlock className={className}>
        <CodeBlockCode code={children as string} language={language} />
      </CodeBlock>
    );
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>;
  },

  // ── Headings — green left-border accent + anchor link (T3) ──
  h1: function H1({ children }) {
    return (
      <h1 className="group/h border-l-2 border-primary pl-3 text-lg font-bold mt-6 mb-3 first:mt-0 text-primary selection:bg-muted-foreground/20 selection:text-muted-foreground">
        {children}
      </h1>
    );
  },
  h2: function H2({ children }) {
    const id = slugifyHeading(children);
    return (
      <h2
        id={id}
        className="group/h flex items-baseline border-l-2 border-primary/60 pl-3 text-base font-bold mt-5 mb-2.5 first:mt-0 scroll-mt-4 text-primary selection:bg-muted-foreground/20 selection:text-muted-foreground"
      >
        <span>{children}</span>
        <AnchorButton id={id} />
      </h2>
    );
  },
  h3: function H3({ children }) {
    const id = slugifyHeading(children);
    return (
      <h3
        id={id}
        className="group/h flex items-baseline border-l-2 border-primary/40 pl-3 text-sm font-semibold mt-4 mb-2 first:mt-0 scroll-mt-4 text-primary/80 selection:bg-muted-foreground/20 selection:text-muted-foreground"
      >
        <span>{children}</span>
        <AnchorButton id={id} />
      </h3>
    );
  },
  h4: function H4({ children }) {
    const id = slugifyHeading(children);
    return (
      <h4
        id={id}
        className="group/h flex items-baseline text-sm font-semibold mt-3 mb-1.5 text-primary/70 first:mt-0 scroll-mt-4 selection:bg-muted-foreground/20 selection:text-muted-foreground"
      >
        <span>{children}</span>
        <AnchorButton id={id} />
      </h4>
    );
  },

  // ── Blockquote ──
  blockquote: function Blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-primary/40 bg-primary/5 rounded-r-lg pl-4 pr-3 py-2 my-3 text-foreground/80 italic [&>p]:my-1">
        {children}
      </blockquote>
    );
  },

  // ── Lists ──
  ul: function Ul({ children }) {
    return (
      <ul className="my-2.5 ml-1 space-y-1.5 list-none [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:left-1 [&>li]:before:top-[0.6em] [&>li]:before:h-1.5 [&>li]:before:w-1.5 [&>li]:before:rounded-full [&>li]:before:bg-primary/50">
        {children}
      </ul>
    );
  },
  ol: function Ol({ children }) {
    return (
      <ol className="my-2.5 ml-1 space-y-1.5 list-decimal pl-5 marker:text-primary/60 marker:font-mono marker:text-xs marker:font-medium">
        {children}
      </ol>
    );
  },
  li: function Li({ children }) {
    return <li>{children}</li>;
  },

  // ── Links — T2: internal links use react-router, external open new tab ──
  a: function Anchor({ href, children }) {
    const cls =
      "text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 hover:text-primary transition-colors";
    if (href?.startsWith("/")) {
      return (
        <Link to={href} className={cls}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {children}
      </a>
    );
  },

  // ── Images (clickable lightbox) & PDF embeds (open in new tab) ──
  img: function Img({ src, alt }) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const [lightboxOpen, setLightboxOpen] = useState(false);

    if (!src) {
      return null;
    }

    // Markdown files: clickable card that opens a lightbox.
    if (alt?.startsWith("md:")) {
      const fileName = alt.slice(3) || "Markdown file";
      return <MarkdownFileCard src={src} fileName={fileName} />;
    }

    // PDF embeds: render inline preview + "Open in new tab" button.
    if (alt?.startsWith("pdf:")) {
      const title = alt.slice(4) || "PDF";
      return (
        <div className="my-4 rounded-lg border border-border overflow-hidden group/pdf">
          <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5 border-b border-border/50">
            <span className="text-xs font-medium text-muted-foreground truncate">{title}</span>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] text-primary/70 hover:text-primary transition-colors shrink-0"
            >
              <ExternalLink className="h-3 w-3" />
              Open
            </a>
          </div>
          <iframe src={src} title={title} className="w-full" style={{ height: "600px" }} />
        </div>
      );
    }

    // Images: clickable thumbnail that opens a lightbox overlay.
    return (
      <>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="group/img my-4 rounded-lg border border-border overflow-hidden cursor-zoom-in relative block"
        >
          <img
            src={src}
            alt={alt ?? ""}
            style={{ maxWidth: "100%", height: "auto", display: "block" }}
            loading="eager"
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/img:bg-black/20 transition-colors">
            <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-80 transition-opacity drop-shadow-md" />
          </span>
        </button>

        {/* Lightbox overlay */}
        {lightboxOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in-0 duration-150"
            onClick={() => setLightboxOpen(false)}
          >
            <button
              className="absolute top-4 right-4 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
              onClick={() => setLightboxOpen(false)}
            >
              <X className="h-5 w-5" />
            </button>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute top-4 right-16 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
              title="Open in new tab"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-5 w-5" />
            </a>
            <img
              src={src}
              alt={alt ?? ""}
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  },

  // ── Horizontal rule ──
  hr: function Hr() {
    return <hr className="my-5 border-t border-primary/20" />;
  },

  // ── Tables ──
  table: function Table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">{children}</table>
      </div>
    );
  },
  thead: function Thead({ children }) {
    return <thead className="bg-primary/8 border-b border-primary/20">{children}</thead>;
  },
  th: function Th({ children }) {
    return (
      <th className="px-3 py-2 text-left text-xs font-semibold text-primary/80 uppercase tracking-wide">
        {children}
      </th>
    );
  },
  td: function Td({ children }) {
    return <td className="px-3 py-2 border-t border-border/50 text-foreground/90">{children}</td>;
  },

  // ── Paragraphs ──
  // If a paragraph contains an image, render as <div> to avoid invalid
  // HTML nesting (block <img> inside <p> causes browser to break the DOM).
  p: function P({ children, node }) {
    const hasImage = node?.children?.some(
      (child) => child.type === "element" && child.tagName === "img",
    );
    if (hasImage) {
      return <div className="my-2.5 leading-relaxed first:mt-0 last:mb-0">{children}</div>;
    }
    return <p className="my-2.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>;
  },

  // ── Strong ──
  strong: function Strong({ children }) {
    return <strong className="font-semibold text-foreground">{children}</strong>;
  },
};

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string;
    components?: Partial<Components>;
  }) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    );
  },
  function propsAreEqual(prevProps, nextProps) {
    return prevProps.content === nextProps.content;
  },
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

/**
 * Pre-process markdown text to convert workspace file paths into inline previews.
 * Handles images (png, jpg, gif, webp, svg) and PDFs.
 * Handles both default workspace (`~/.openclaw/workspace/`) and agent-scoped
 * workspaces (`~/.openclaw/agents/{id}/workspace/`).
 * Also handles paths wrapped in backticks (inline code) — the backticks are
 * removed so the preview renders properly.
 */
function rewriteWorkspaceFilePaths(text: string, agentId: string): string {
  // Match workspace file paths, optionally wrapped in single backticks.
  // Two workspace layouts:
  //   ~/.openclaw/workspace/{path}                   (default agent)
  //   ~/.openclaw/agents/{id}/workspace/{path}       (named agent)
  // With absolute prefix variants:
  //   /Users/xxx/.openclaw/...
  //   /home/xxx/.openclaw/...
  const filePathRe =
    /`?((?:~|\/(?:Users|home)\/[^\s/`]+)\/\.openclaw\/(?:agents\/[^\s/`]+\/)?workspace\/([\w./_-]+\.(?:png|jpe?g|gif|webp|svg|pdf|md|mdx|markdown)))`?/gi;

  let result = text.replace(filePathRe, (match, _fullPath: string, relativePath: string) => {
    // Skip if already inside markdown image/link syntax (preceded by ![ or ]( )
    const idx = text.indexOf(match);
    if (idx > 0) {
      const before = text.slice(Math.max(0, idx - 2), idx);
      if (before.endsWith("![") || before.endsWith("](")) {
        return match;
      }
    }
    const segments = relativePath.split("/").map(encodeURIComponent).join("/");
    const url = `/api/workspace-files/${encodeURIComponent(agentId)}/${segments}`;
    const fileName = relativePath.split("/").pop() ?? relativePath;
    const isPdf = /\.pdf$/i.test(relativePath);
    const isMd = /\.(?:md|mdx|markdown)$/i.test(relativePath);
    if (isPdf) {
      return `\n![pdf:${fileName}](${url})\n`;
    }
    if (isMd) {
      return `\n![md:${fileName}](${url})\n`;
    }
    return `\n![${fileName}](${url})\n`;
  });

  // Also match file paths to images/PDFs outside the workspace.
  // Matches: /Users/xxx/..., /home/xxx/..., ~/...
  const absolutePathRe =
    /`?((?:~|\/(?:Users|home)\/[^\s/`]+)\/[^\s`]+\.(?:png|jpe?g|gif|webp|svg|pdf))`?/gi;

  result = result.replace(absolutePathRe, (match, fullPath: string) => {
    // Skip if already rewritten or inside markdown syntax
    const idx = result.indexOf(match);
    if (idx > 0) {
      const before = result.slice(Math.max(0, idx - 2), idx);
      if (before.endsWith("![") || before.endsWith("](")) {
        return match;
      }
    }
    // Skip workspace paths (already handled by the first rewriter above)
    if (fullPath.includes("/.openclaw/") && fullPath.includes("/workspace/")) {
      return match;
    }
    const fileName = fullPath.split("/").pop() ?? fullPath;
    const url = `/api/project-files?path=${encodeURIComponent(fullPath)}`;
    const isPdf = /\.pdf$/i.test(fullPath);
    if (isPdf) {
      return `\n![pdf:${fileName}](${url})\n`;
    }
    return `\n![${fileName}](${url})\n`;
  });

  return result;
}

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
  agentId,
}: MarkdownProps) {
  const generatedId = useId();
  const blockId = id ?? generatedId;
  const processedChildren = useMemo(
    () => (agentId ? rewriteWorkspaceFilePaths(children, agentId) : children),
    [children, agentId],
  );
  const blocks = useMemo(() => parseMarkdownIntoBlocks(processedChildren), [processedChildren]);

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
        />
      ))}
    </div>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
