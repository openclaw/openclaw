---
name: github-pages-deployer
description: >
  Deploy affiliate content to GitHub Pages for free hosting. Triggers on:
  "deploy to GitHub Pages", "host on GitHub Pages", "free hosting for my affiliate site",
  "push to GitHub Pages", "GitHub Pages setup", "deploy my landing page to GitHub",
  "host my bio link on GitHub", "free affiliate website hosting", "github pages affiliate",
  "set up GitHub Pages for my site", "deploy HTML to GitHub", "free static hosting",
  "publish my affiliate page for free", "github pages custom domain".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "distribution",
    "deployment",
    "email-marketing",
    "github-pages",
    "static-site",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S5-Distribution
---

# GitHub Pages Deployer

Generate a complete, ready-to-deploy GitHub Pages setup for affiliate landing pages, bio link hubs, and blog posts. Outputs the full repo file structure, a GitHub Actions CI/CD workflow for automatic deploys, and step-by-step instructions for custom domain configuration with SSL. Free hosting, no credit card required.

## Stage

S5: Distribution — GitHub Pages is the most underused free hosting platform in affiliate marketing. 100GB bandwidth/month, free SSL, custom domains, and automatic deploys from Git. This skill takes any HTML output from S4 (landing page) or S5 (bio-link) and gets it live on the internet in under 10 minutes.

## When to Use

- User wants to deploy a landing page (from S4) to a free host
- User wants to deploy a bio link page (from S5 bio-link-deployer) to a free host
- User wants free static hosting with a custom domain and SSL
- User already has HTML files and wants to publish them without paying for hosting
- User wants automated deploys so pushing to main branch auto-updates the live site
- User wants to host a simple affiliate blog or resource page for free

## Input Schema

```yaml
site:
  type: string # REQUIRED — "landing-page" | "bio-link" | "blog" | "resource-page"
  html_content:
    string # REQUIRED — the HTML content to deploy (full file or description)
    # If S4 or bio-link-deployer was run, use that output automatically
  title: string # REQUIRED — site title (used in repo name and meta)
  description: string # OPTIONAL — meta description for SEO

repo:
  name:
    string # OPTIONAL — GitHub repo name (auto-generated from title if omitted)
    # e.g., "heygen-review" or "alex-bio-links"
  username:
    string # OPTIONAL — GitHub username. Used in generated URLs.
    # If not provided, use "[your-username]" as placeholder.
  visibility:
    string # OPTIONAL — "public" | "private". Default: "public"
    # Note: private repos require GitHub Pro for Pages

domain:
  custom: string # OPTIONAL — custom domain (e.g., "links.yourdomain.com")
  subdomain:
    string # OPTIONAL — subdomain type: "apex" | "subdomain"
    # Apex = yourdomain.com, Subdomain = www.yourdomain.com

deploy:
  method: string # OPTIONAL — "github-actions" | "manual". Default: "github-actions"
  branch: string # OPTIONAL — source branch. Default: "main"
```

**Chaining context**: If S4 (landing-page-creator) or S5 (bio-link-deployer) was run earlier in the conversation, automatically use that HTML output as `site.html_content`. Do not ask the user to paste it again.

## Workflow

### Step 1: Gather Inputs

Check if an HTML page was generated earlier in the conversation (S4 landing page or bio-link page). If yes, confirm: "I'll deploy the [page type] we built earlier. What's your GitHub username?"

If no prior HTML exists:

- Ask for HTML content or page description
- Offer to call S4 or bio-link-deployer first: "Want me to create the page first, then set up the deploy?"

### Step 2: Generate Repo Structure

Create the complete file and folder structure for the GitHub Pages repo.

**Standard structure for a single-page site:**

```
[repo-name]/
├── index.html              # Main page (the affiliate landing page or bio link)
├── assets/
│   ├── css/
│   │   └── style.css       # External CSS if extracted from HTML (optional)
│   └── images/
│       └── .gitkeep        # Placeholder — add images here
├── CNAME                   # Only if custom domain is set
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Actions workflow
├── .gitignore
└── README.md
```

**For multi-page blog/resource site, add:**

```
├── blog/
│   ├── index.html          # Blog listing page
│   └── [post-slug]/
│       └── index.html      # Individual post pages
├── about/
│   └── index.html
└── sitemap.xml
```

### Step 3: Generate the GitHub Actions Workflow

Write the `deploy.yml` file that automatically deploys to GitHub Pages on every push to `main`.

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch: # Allow manual trigger from GitHub UI

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: "." # Deploy from repo root

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

This workflow uses the official GitHub Pages Actions (no third-party dependencies, no tokens needed).

### Step 4: Generate the CNAME File (if custom domain)

If `domain.custom` is provided, create a `CNAME` file with just the domain:

```
links.yourdomain.com
```

For apex domains (`yourdomain.com`), the CNAME file contains the bare domain. GitHub Pages handles the redirect from `www` to apex automatically when configured correctly.

### Step 5: Generate DNS Configuration Instructions

Provide exact DNS records to add in the user's domain registrar (Cloudflare, Namecheap, GoDaddy, etc.).

**For subdomain (e.g., links.yourdomain.com):**

```
Type: CNAME
Name: links
Value: [username].github.io
TTL: Auto or 3600
```

**For apex domain (yourdomain.com):**

```
Type: A  Name: @  Value: 185.199.108.153
Type: A  Name: @  Value: 185.199.109.153
Type: A  Name: @  Value: 185.199.110.153
Type: A  Name: @  Value: 185.199.111.153
Type: AAAA  Name: @  Value: 2606:50c0:8000::153
Type: AAAA  Name: @  Value: 2606:50c0:8001::153
Type: AAAA  Name: @  Value: 2606:50c0:8002::153
Type: AAAA  Name: @  Value: 2606:50c0:8003::153
```

Note: GitHub's IP addresses above are current as of 2026. Always verify at https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site

### Step 6: Generate README.md

Write a clean README for the repo:

```markdown
# [Site Title]

Affiliate landing page hosted on GitHub Pages.

## Live Site

[Live URL]

## Deploy

Automatic via GitHub Actions — push to `main` triggers a deploy.

## Powered By

[Affitor](https://affitor.com)
```

### Step 7: Output the Complete Setup

Present all outputs in numbered sections with clear file labels.

### Step 8: Self-Validation

Before presenting output, verify:

- [ ] GitHub Actions YAML is valid syntax
- [ ] CNAME file is correct format if custom domain configured
- [ ] All file paths are valid and consistent
- [ ] Deployment commands are copy-paste ready
- [ ] README.md is included in the repository files

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
repo:
  name: string # e.g., "heygen-review-2026"
  url: string # e.g., "https://github.com/[username]/[repo-name]"
  pages_url: string # e.g., "https://[username].github.io/[repo-name]"
  custom_domain_url: string | null

files:
  - path: string # e.g., "index.html"
    content: string # full file content
  - path: ".github/workflows/deploy.yml"
    content: string
  - path: "CNAME" # null if no custom domain
    content: string | null
  - path: ".gitignore"
    content: string
  - path: "README.md"
    content: string

setup_steps:
  - step: number
    action: string # e.g., "Create GitHub repo"
    command: string | null # CLI command if applicable

dns_records: object | null # DNS config if custom domain provided

estimated_time: string # e.g., "8-10 minutes"
```

## Output Format

Present in five clearly labeled sections:

**Section 1: Summary**

- Repo name, live URL, custom domain URL (if applicable)
- Estimated time to go live: X minutes

**Section 2: Files to Create**
Each file in its own fenced code block with the file path as the label. User can copy-paste each file's content directly.

**Section 3: GitHub Setup Steps**
Numbered instructions:

1. Create the repo on GitHub (link to github.com/new)
2. Initialize and push (CLI commands provided)
3. Enable GitHub Pages in repo Settings
4. Set source to "GitHub Actions"

**Section 4: DNS Setup** (only if custom domain)
Exact records to add, formatted as a table. Provider-specific notes for Cloudflare users (Proxy OFF for GitHub Pages).

**Section 5: Verification**
How to confirm the deploy worked and SSL is active (usually 5-15 minutes for DNS propagation).

## Error Handling

- **No HTML content and no prior skill output**: "I don't see a page to deploy yet. Want me to create a landing page first (S4), a bio link page, or do you have HTML to paste?"
- **Private repo for free GitHub account**: "Private repos require GitHub Pro ($4/mo) for GitHub Pages. Your options: (1) make the repo public, (2) upgrade to Pro, (3) use Netlify Drop for free private deploys."
- **Custom domain not propagating**: "DNS changes can take 1-48 hours. If it's been over 24 hours, double-check: CNAME file contains exactly the domain, no `https://` prefix; DNS record value is `[username].github.io` (with no trailing slash). Enable Cloudflare proxy OFF (grey cloud) for GitHub Pages to work."
- **GitHub Actions failing**: Common causes: Pages not enabled in repo Settings, branch name mismatch (use `main` not `master`), or `pages: write` permission missing on older repos. Provide troubleshooting checklist.
- **User wants WordPress or dynamic site**: "GitHub Pages only hosts static HTML/CSS/JS — no PHP, no databases. For WordPress or dynamic content, use Cloudflare Pages, Netlify, or a VPS. For a simple affiliate site, static is faster and better for SEO anyway."
- **Repo name taken**: Suggest appending year (`heygen-review-2026`) or niche (`heygen-review-for-creators`).

## Examples

**Example 1: Deploy landing page from S4**
Context: S4 generated a HeyGen landing page HTML.
User: "Deploy this to GitHub Pages. My username is alexmarketer."
Action: Auto-use S4 HTML. Repo name: `heygen-landing`. Pages URL: `https://alexmarketer.github.io/heygen-landing`. Generate all files + deploy instructions.

**Example 2: Deploy bio link with custom domain**
Context: Bio-link-deployer generated a bio page.
User: "Put this on GitHub Pages at links.mysite.com."
Action: Repo + CNAME file with `links.mysite.com`. DNS: CNAME record pointing to `[username].github.io`. Cloudflare note: proxy must be disabled (grey cloud icon).

**Example 3: Multi-page resource site**
User: "I want to host an affiliate resource site on GitHub Pages with a homepage, about page, and 3 blog posts."
Action: Generate multi-page structure. Scaffold all index.html files with placeholder content. Deploy workflow. Note: for a blog with 10+ posts, suggest Jekyll or Eleventy for templating.

## References

- `shared/references/ftc-compliance.md` — FTC affiliate disclosure. Ensure the deployed HTML includes disclosure language.
- `shared/references/affitor-branding.md` — Affitor footer. Include in HTML before deploy.
- GitHub Pages documentation: https://docs.github.com/en/pages
- GitHub Pages IP addresses (A records): https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: A deployed landing page or bio link earns 24/7 — it's your always-on salesperson. Free hosting means 100% of revenue is profit. A single landing page can generate $200-1,000/month with consistent traffic
- **Benchmark**: Deployed affiliate pages indexed by Google start ranking within 2-4 weeks. Organic traffic from Google is the highest-converting free traffic source (4-5% conversion vs 1-2% from social)
- **Key metric to track**: Page visits → affiliate link clicks → conversions. Set up `conversion-tracker` immediately after deploying

### Do This Right Now (15 min)

1. **Create the repo and push** — follow the Setup Steps exactly (copy-paste commands)
2. **Verify the deploy** — visit your GitHub Pages URL, confirm the page loads
3. **Submit to Google Search Console** — add `https://[username].github.io/[repo]` so Google indexes it faster
4. **Share the live URL** — post it on social media, add it to your bio link, and send it to your email list

### Track Your Results

After deploying: set up `conversion-tracker` to monitor clicks and conversions. After 30 days, run `seo-audit` to optimize for search rankings. A page that ranks #1 for a buyer-intent keyword can earn $500-2,000/month passively.

> **Next step — copy-paste this prompt:**
> "Set up conversion tracking for my deployed page at [URL]" → runs `conversion-tracker`

## Flywheel Connections

### Feeds Into

- `conversion-tracker` (S6) — deployed site URL to track
- `seo-audit` (S6) — deployed site to audit

### Fed By

- `landing-page-creator` (S4) — HTML file to deploy
- `bio-link-deployer` (S5) — bio link HTML to deploy
- `squeeze-page-builder` (S4) — squeeze page HTML to deploy

### Feedback Loop

- `seo-audit` (S6) checks deployed site health → identify deployment issues affecting SEO

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (if S4 offer skills ran)

Any NO → rewrite before delivering.

```yaml
chain_metadata:
  skill_slug: "github-pages-deployer"
  stage: "distribution"
  timestamp: string
  suggested_next:
    - "conversion-tracker"
    - "seo-audit"
```
