import { BookOpen, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink, useParams, Navigate } from "react-router-dom";
import { Markdown } from "@/components/ui/custom/prompt/markdown";
import { Input } from "@/components/ui/input";
import { docsCategories, docsPages } from "@/lib/docs-content";
import { cn } from "@/lib/utils";

function DocsSidebar({
  activePage,
  search,
  onSearchChange,
}: {
  activePage: string;
  search: string;
  onSearchChange: (v: string) => void;
}) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => {
    // Expand the category containing the active page by default
    const activeCategory = docsPages[activePage]?.category;
    return new Set(activeCategory ? [activeCategory] : ["overview"]);
  });

  const filteredCategories = useMemo(() => {
    if (!search.trim()) {
      return docsCategories;
    }
    const q = search.toLowerCase();
    return docsCategories
      .map((cat) => ({
        ...cat,
        pages: cat.pages.filter((slug) => {
          const page = docsPages[slug];
          return page && (page.title.toLowerCase().includes(q) || page.slug.includes(q));
        }),
      }))
      .filter((cat) => cat.pages.length > 0);
  }, [search]);

  const toggleCategory = (id: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-2 w-56 shrink-0 border-r border-border pr-4">
      <Input
        placeholder="Filter pages…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="h-8 text-xs"
      />
      <nav className="flex flex-col gap-1 mt-1">
        {filteredCategories.map((cat) => {
          const isExpanded = expandedCategories.has(cat.id) || search.trim().length > 0;
          const pages = cat.pages.map((slug) => docsPages[slug]).filter(Boolean);
          return (
            <div key={cat.id}>
              <button
                onClick={() => toggleCategory(cat.id)}
                className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors rounded-md"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform duration-200",
                    isExpanded && "rotate-90",
                  )}
                />
                {cat.label}
              </button>
              {isExpanded && (
                <div className="flex flex-col gap-0.5 ml-4">
                  {pages.map((page) => (
                    <NavLink
                      key={page.slug}
                      to={page.slug === "index" ? "/docs" : `/docs/${page.slug}`}
                      className={cn(
                        "px-2 py-1 text-xs rounded-md transition-colors truncate",
                        activePage === page.slug
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted",
                      )}
                    >
                      {page.title}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

export function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const [search, setSearch] = useState("");

  const activeSlug = slug ?? "index";
  const page = docsPages[activeSlug];

  if (!page) {
    return <Navigate to="/docs" replace />;
  }

  const category = docsCategories.find((c) => c.id === page.category);

  return (
    <div className="flex h-full">
      <DocsSidebar activePage={activeSlug} search={search} onSearchChange={setSearch} />
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-4">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
          <BookOpen className="h-3.5 w-3.5" />
          <span>Docs</span>
          {category && (
            <>
              <ChevronRight className="h-3 w-3" />
              <span>{category.label}</span>
            </>
          )}
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground">{page.title}</span>
        </div>
        {/* Content */}
        <article className="prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{page.content}</Markdown>
        </article>
      </div>
    </div>
  );
}
