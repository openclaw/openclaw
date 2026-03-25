---
name: bio-link-deployer
description: >
  Create a Linktree-style bio link hub page as a single self-contained HTML file.
  Triggers on: "create a bio link page", "make a linktree", "link in bio page",
  "bio link", "link hub", "create my link page", "all my links on one page",
  "linktree alternative", "build a link page", "bio page for my affiliate links",
  "I need a link in bio", "make a page with all my links", "link aggregator page".
license: MIT
version: "1.0.0"
tags:
  ["affiliate-marketing", "distribution", "deployment", "email-marketing", "bio-link", "linktree"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S5-Distribution
---

# Bio Link Deployer

Create a Linktree-style hub page that links all your affiliate content — blog posts, landing pages, social profiles, and product links — in one place. Output is a single self-contained HTML file with 3 theme options, mobile-first (90%+ bio link traffic is mobile), deployable anywhere.

## Stage

S5: Distribution — The central hub that ties your entire affiliate funnel together. Put this link in your social media bios, email signatures, and anywhere you need one link to rule them all. Unlike Linktree, you own the page and pay nothing.

## When to Use

- User wants a link-in-bio page for social media profiles
- User wants a single page linking all their affiliate content
- User says anything like "linktree", "bio link", "link page", "link in bio", "all my links"
- User has multiple affiliate products/blog posts/landing pages and needs a hub
- User wants a free alternative to Linktree/Beacons/Stan Store

## Input Schema

```yaml
user_name: string # REQUIRED — display name or handle (e.g., "@alexcreator")

tagline:
  string # OPTIONAL — short bio under the name
  # Default: auto-generated from link categories

avatar_url:
  string # OPTIONAL — URL to profile image
  # Default: emoji placeholder based on niche

links: # REQUIRED — at least 3 links
  - label: string # Display text (e.g., "HeyGen — AI Video Creator")
    url: string # Destination URL
    category: string # Group label (e.g., "Tools", "My Content", "Connect")
    icon: string # OPTIONAL — emoji for visual (e.g., "🎬")

theme:
  string # OPTIONAL — "minimal" | "dark" | "gradient"
  # Default: "minimal"
```

**Chaining context**: If earlier skills (S1-S4) were run in the conversation, use these Output Schema fields:

- S1 `recommended_program.url` + `.name` → add as "Featured Tools" links
- S2 `posts[].platform` → link to the user's social platform profiles
- S3 `products_featured[].url` + `.name` → add as "My Content" links (blog posts)
- S4 `landing_page.filename` or deployed URL → add as "Landing Pages" links
- S4 `products_featured[].url` + `.name` → add as product links if not already included

If the user says "make me a bio link with everything we've done" — gather all products, blog posts, and landing pages from the conversation and organize them into categories.

## Workflow

### Step 1: Gather Links

Collect links from one of these sources:

**Option A — User provides links directly:**
Use the `links` array as-is. Ensure each link has a label, url, and category.

**Option B — Gather from conversation context:**
If prior skills (S1-S4) were run, collect:

- Product affiliate URLs → category: "Featured Tools"
- Blog post URLs → category: "My Content"
- Landing page URLs → category: "Landing Pages"
- Social media profiles (if mentioned) → category: "Connect"

**Option C — User provides partial info:**
Ask for missing required fields. Minimum: user_name + 3 links.

Organize links by category. Suggested category order:

1. "Featured Tools" (affiliate product links — money links first)
2. "My Content" (blog posts, landing pages, videos)
3. "Connect" (social media, email, website)

### Step 2: Build Page

Read `templates/bio-link.html` for the page structure and all three theme variants.

Apply the chosen `theme`:

**Minimal (default):**

- Clean white background, subtle borders
- Dark text, light gray accents
- Rounded corners (12px)
- Best for: professional, clean look

**Dark:**

- Dark navy background (#0f172a)
- Light text, blue accents
- Subtle card borders
- Best for: tech, gaming, modern brands

**Gradient:**

- Purple-to-blue gradient background
- White text, frosted-glass link cards
- Large rounded corners (24px)
- Best for: creative, lifestyle, bold brands

Set CSS variables in `:root` based on the chosen theme. Remove the other theme blocks from the template.

If `avatar_url` is provided, use an `<img>` tag. Otherwise, use the emoji placeholder div with an emoji matching the user's niche (default: 🚀).

### Step 3: Output

Present the final output in this structure:

**Part 1: Page Summary**

```
---
BIO LINK PAGE
---
Name: [user_name]
Theme: [minimal/dark/gradient]
Links: [count]
Categories: [list]
---
```

**Part 2: Complete HTML**
The full HTML file in a fenced code block (```html). Save as `index.html`(or`links.html`) and open in any browser.

**Part 3: Deploy Instructions**
Read `references/domain-setup.md` and provide the deploy options:

```
---
DEPLOY
---
1. Save as `index.html`
2. Preview: open the file in your browser
3. Deploy (pick one):
   - Netlify Drop: drag the file to https://app.netlify.com/drop (30 seconds)
   - Vercel: `npx vercel deploy --prod` (needs Node.js)
   - GitHub Pages: push to repo → Settings → Pages → main branch
4. Add to your social bios: paste the URL in your Instagram, X, TikTok, LinkedIn bio
5. Custom domain: see references/domain-setup.md for DNS setup guide
---
```

### Step 4: Self-Validation

Before presenting output, verify:

- [ ] All links are functional URLs (not placeholder)
- [ ] Mobile-first layout renders correctly at 375px width
- [ ] Theme CSS custom properties applied consistently
- [ ] FTC disclosure present if any affiliate links included
- [ ] "Built with Affiliate Skills by Affitor" footer present
- [ ] Money links (affiliate) ordered before social/content links

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
bio_link:
  user_name: string # Display name
  theme: string # Applied theme
  html: string # Complete self-contained HTML
  filename: string # Suggested filename (e.g., "index.html")
  link_count: number # Total links on the page
  categories: string[] # Categories used

deploy:
  local: string # "Open index.html in browser"
  netlify: string # Netlify Drop instructions
  vercel: string # Vercel deploy command
  github_pages: string # GitHub Pages instructions
```

## Output Format

Present the output as three clearly separated sections:

1. **Page Summary** — name, theme, link count, categories
2. **HTML** — the complete file in a code block, ready to save
3. **Deploy Instructions** — how to get the page live and add to social bios

The HTML should be **immediately usable** — save as `.html`, open in browser, and it works. No build step, no dependencies, mobile-optimized.

## Error Handling

- **No links provided**: "I need at least 3 links to create your bio page. List your affiliate product URLs, blog posts, social profiles, or landing pages."
- **No user_name**: "What name or handle should I display? (e.g., @yourusername)"
- **Invalid avatar_url**: Use emoji placeholder instead. Note: "I couldn't load the avatar image, so I used an emoji placeholder. You can replace it later by editing the HTML."
- **Unknown theme**: Default to minimal. Inform: "I used the 'minimal' theme. Available themes: minimal, dark, gradient."
- **Too many links (20+)**: Include all but suggest: "That's a lot of links — consider featuring your top 10-15 and linking to a full directory page for the rest."
- **No categories provided**: Auto-categorize based on URL patterns (social domains → "Connect", blog URLs → "My Content", product URLs → "Tools").

## Examples

### Example 1: Full Input

**User**: "Create a dark-themed bio link page for @sarahcontent with these links: HeyGen (heygen.com/ref), Semrush (semrush.com/ref), My HeyGen Review (blog.com/heygen), Follow on X (x.com/sarah)"
**Action**: theme=dark, organize into 3 categories (Tools, Content, Connect), generate HTML.

### Example 2: From Conversation Context

**User**: "Make me a bio link page with everything we've done today"
**Context**: S1 found HeyGen, S3 wrote a blog post, S4 made a landing page
**Action**: Gather all URLs from conversation, auto-categorize, default theme=minimal, generate HTML.

### Example 3: Minimal Input

**User**: "I need a link in bio page"
**Action**: Ask for user_name and links. Provide example: "What's your display name and what links do you want? For example: product URLs, blog posts, social profiles."

## References

- `templates/bio-link.html` — Bio link page template with 3 theme variants (minimal, dark, gradient). Read in Step 2.
- `references/domain-setup.md` — Hosting and domain setup guide for Netlify Drop, Vercel, GitHub Pages. Read in Step 3.
- `shared/references/ftc-compliance.md` — FTC disclosure for bio link pages (footer text). Reference in Step 2.
- `shared/references/affitor-branding.md` — Affitor footer HTML. Reference in Step 2.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Your bio link is the funnel entrance for ALL social media traffic. Average bio link CTR is 1-3% of profile visitors. With 5,000 monthly profile views → 50-150 clicks → at 3% affiliate conversion and $50 commission = $75-225/month. Top creators with optimized bio links report $500-2,000/month
- **Benchmark**: Money links (affiliate products) placed at position 1-2 get 60% of all bio link clicks. Position matters more than design
- **Key metric to track**: Per-link click rate — which links get clicked most? Reorder weekly to keep the highest-performing link at the top

### Do This Right Now (15 min)

1. **Deploy the page** — use Netlify Drop (drag and drop, 30 seconds)
2. **Update ALL your social bios** — Instagram, TikTok, X, LinkedIn, YouTube — with the new bio link URL
3. **Verify on mobile** — 90%+ of bio link traffic is mobile. Open the link on your phone right now
4. **Bookmark your analytics** — if using Netlify, check Netlify Analytics or add a free analytics snippet

### Track Your Results

After 7 days: which link gets the most clicks? Is it your top affiliate product? If not, reorder links — put the money link at position #1. Check weekly and rotate based on performance.

> **Next step — copy-paste this prompt:**
> "Deploy my bio link page to GitHub Pages with a custom domain" → runs `github-pages-deployer`

## Flywheel Connections

### Feeds Into

- `conversion-tracker` (S6) — deployed link hub URLs to track clicks
- `github-pages-deployer` (S5) — bio link HTML to deploy

### Fed By

- `landing-page-creator` (S4) — landing page URLs to add to link hub
- `squeeze-page-builder` (S4) — squeeze page URLs for link hub
- `webinar-registration-page` (S4) — registration page URLs for link hub

### Feedback Loop

- `conversion-tracker` (S6) reveals which bio links get the most clicks → reorder links to put highest-converting at top

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
  skill_slug: "bio-link-deployer"
  stage: "distribution"
  timestamp: string
  suggested_next:
    - "github-pages-deployer"
    - "conversion-tracker"
```
