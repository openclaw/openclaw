# Affiliate Funnel Overview

This document explains the five-stage affiliate funnel that organizes all skills in this repo. If you're contributing a new skill, read this first.

## The Five Stages

Every affiliate marketer, regardless of experience level, goes through these stages:

### S1: Research

**Question:** "What should I promote?"

Find and evaluate affiliate programs. Score them on earning potential, content potential, market demand, competition, and trust. Pick the best fit for your niche and audience.

**Path:** `skills/research/`
**Current skill:** `affiliate-program-search`
**Open for contribution:** industry-specific scanners (crypto, fintech, health tech)

### S2: Content

**Question:** "How do I tell people about it?"

Create promotional content for social media platforms. Each platform has different rules, formats, and audiences. Content should be genuine recommendations, not ads.

**Path:** `skills/content/`
**Current skill:** `viral-post-writer`
**Open for contribution:** TikTok script writer, email sequence builder, YouTube script writer

### S3: Blog

**Question:** "How do I rank on Google for this?"

Write SEO-optimized blog posts that rank for buyer-intent keywords. Reviews, comparisons, and listicles that drive organic traffic and convert over months/years.

**Path:** `skills/blog/`
**Current skill:** `affiliate-blog-builder`
**Open for contribution:** podcast show notes, newsletter builder

### S4: Landing

**Question:** "Where do I send traffic?"

Build dedicated landing pages that warm up visitors before sending them to the merchant's site. Higher conversion than sending people directly to a product page.

**Path:** `skills/landing/`
**Current skill:** `landing-page-creator`
**Open for contribution:** webinar registration page, quiz funnel builder

### S5: Distribution

**Question:** "How do I get my links out there?"

Create a central hub for all your affiliate links. Bio link pages, portfolio sites, link aggregators. Deploy to any static host.

**Path:** `skills/distribution/`
**Current skill:** `bio-link-deployer`
**Open for contribution:** GitHub Pages deployer, Notion portfolio builder

## How Stages Connect

```
S1 → picks a program
  ↓
S2 → writes content about it (social media, quick distribution)
  ↓
S3 → writes long-form content (blog, SEO, long-term traffic)
  ↓
S4 → builds a dedicated page (highest conversion)
  ↓
S5 → creates a hub linking everything together
```

Output of each stage feeds naturally into the next. But each stage also works independently.

## Two Paths

Not everyone follows the same order:

**Social path (fast, needs consistency):**
S1 → S2 → repeat. Post regularly, build audience, earn from day one.

**Content path (slow, compounds over time):**
S1 → S3 → S4. Write once, rank on Google, earn passively for years.

Most successful affiliates do both.

## Contributing a New Skill

1. Pick a stage that your skill belongs to
2. Read `template/SKILL.md` and existing skills in that stage
3. Create your skill at `skills/{stage}/{skill-name}/SKILL.md`
4. Build with Input/Output Schemas for agent chaining
5. Test with 3 prompts, submit a PR
6. See `CONTRIBUTING.md` for full details
