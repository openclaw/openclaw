import { marked } from "marked";
import React, { memo, useCallback, useId, useMemo, useState } from "react";
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

  // ── Images ──
  img: function Img({ src, alt }) {
    if (!src) {
      return null;
    }
    return (
      <span className="block my-4">
        <img
          src={src}
          alt={alt ?? ""}
          style={{ maxWidth: "100%", height: "auto", display: "block" }}
        />
      </span>
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
  p: function P({ children }) {
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

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  const generatedId = useId();
  const blockId = id ?? generatedId;
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);

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
