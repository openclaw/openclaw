# Flywheel Connections — Master Map

The Affitor Flywheel is a closed-loop system where analytics feedback flows back to research, creating continuous improvement across all 44 skills.

```
  S1 RESEARCH ──▶ S2 CONTENT ──▶ S3 BLOG & SEO ──▶ S4 OFFERS & LANDING
       ▲                                                    │
       │                                                    ▼
       │                                              S5 DISTRIBUTION
       │                                                    │
       └──────────── S6 ANALYTICS ◀─────────────────────────┘
                          │
                          ▼
                    S7 AUTOMATION → SCALE
                          │
                    S8 META (across all)
```

## Connection Map

### S1 Research → S2 Content

| From Skill               | To Skill                | Data Flowing                                    |
| ------------------------ | ----------------------- | ----------------------------------------------- |
| affiliate-program-search | viral-post-writer       | `recommended_program` (product data)            |
| affiliate-program-search | twitter-thread-writer   | `recommended_program` (product data)            |
| affiliate-program-search | reddit-post-writer      | `recommended_program` (product data)            |
| affiliate-program-search | tiktok-script-writer    | `recommended_program` (product data)            |
| affiliate-program-search | content-pillar-atomizer | `recommended_program` (product data)            |
| niche-opportunity-finder | viral-post-writer       | `niche_analysis` (angles, audience)             |
| monopoly-niche-finder    | content-pillar-atomizer | `monopoly_niche` (unique positioning)           |
| purple-cow-audit         | viral-post-writer       | `remarkability_score` (what makes it shareable) |
| competitor-spy           | viral-post-writer       | `competitor_gaps` (content opportunities)       |

### S2 Content → S3 Blog & SEO

| From Skill              | To Skill                  | Data Flowing                                 |
| ----------------------- | ------------------------- | -------------------------------------------- |
| viral-post-writer       | affiliate-blog-builder    | `post_content` (expand into long-form)       |
| content-pillar-atomizer | keyword-cluster-architect | `content_pillars` (topic clusters to target) |
| viral-post-writer       | comparison-post-writer    | `product` (featured product data)            |

### S3 Blog & SEO → S4 Landing

| From Skill                | To Skill             | Data Flowing                                   |
| ------------------------- | -------------------- | ---------------------------------------------- |
| affiliate-blog-builder    | landing-page-creator | `products_featured` (for comparison pages)     |
| keyword-cluster-architect | landing-page-creator | `target_keywords` (SEO-optimized headlines)    |
| content-moat-calculator   | grand-slam-offer     | `authority_gaps` (what to emphasize in offers) |
| affiliate-blog-builder    | bonus-stack-builder  | `products_featured` (products needing bonuses) |

### S4 Landing → S5 Distribution

| From Skill             | To Skill              | Data Flowing                                     |
| ---------------------- | --------------------- | ------------------------------------------------ |
| landing-page-creator   | bio-link-deployer     | `landing_page` (URL to add to link hub)          |
| landing-page-creator   | email-drip-sequence   | `landing_page` (link destination for emails)     |
| landing-page-creator   | github-pages-deployer | `landing_page.html` (file to deploy)             |
| grand-slam-offer       | email-drip-sequence   | `offer_copy` (offer framing for email)           |
| bonus-stack-builder    | email-drip-sequence   | `bonus_stack` (bonus details for email sequence) |
| value-ladder-architect | email-drip-sequence   | `value_ladder` (sequence of offers)              |

### S5 Distribution → S6 Analytics

| From Skill             | To Skill           | Data Flowing                             |
| ---------------------- | ------------------ | ---------------------------------------- |
| bio-link-deployer      | conversion-tracker | `deployed_links` (URLs to track)         |
| email-drip-sequence    | conversion-tracker | `email_links` (links in emails to track) |
| social-media-scheduler | performance-report | `scheduled_posts` (posts to measure)     |
| github-pages-deployer  | seo-audit          | `deployed_url` (site to audit)           |

### S6 Analytics → S1 Research (FEEDBACK LOOP — closes the flywheel)

| From Skill                 | To Skill                 | Data Flowing                                                         |
| -------------------------- | ------------------------ | -------------------------------------------------------------------- |
| conversion-tracker         | affiliate-program-search | `top_converting_niches` → search for more programs in winning niches |
| performance-report         | niche-opportunity-finder | `performance_data` → identify which niches perform best              |
| seo-audit                  | monopoly-niche-finder    | `ranking_data` → find niches where you're already winning            |
| ab-test-generator          | purple-cow-audit         | `winning_variants` → what resonates = what's remarkable              |
| internal-linking-optimizer | content-decay-detector   | `link_structure` → pages with weak links may be decaying             |

### S6 Analytics → S3 Blog (SEO FEEDBACK LOOP)

| From Skill                 | To Skill                  | Data Flowing                                  |
| -------------------------- | ------------------------- | --------------------------------------------- |
| seo-audit                  | keyword-cluster-architect | `ranking_gaps` → keyword opportunities        |
| seo-audit                  | content-decay-detector    | `declining_pages` → content needing refresh   |
| internal-linking-optimizer | affiliate-blog-builder    | `link_suggestions` → internal linking targets |
| performance-report         | content-moat-calculator   | `content_performance` → moat progress         |

### S7 Automation (scales patterns from S6)

| From Skill                 | To Skill                | Data Flowing                                      |
| -------------------------- | ----------------------- | ------------------------------------------------- |
| content-repurposer         | content-pillar-atomizer | `repurposed_content` → atomize further            |
| proprietary-data-generator | affiliate-blog-builder  | `proprietary_data` → unique content angles        |
| proprietary-data-generator | content-moat-calculator | `data_assets` → moat strengtheners                |
| multi-program-manager      | commission-calculator   | `managed_programs` → calculate portfolio earnings |

### S8 Meta (orchestrates all stages)

| From Skill         | To Skill              | Data Flowing                                         |
| ------------------ | --------------------- | ---------------------------------------------------- |
| skill-finder       | any skill             | `matched_skill` → route to right skill               |
| funnel-planner     | all stages            | `roadmap` → week-by-week execution plan              |
| compliance-checker | all content skills    | `compliance_status` → pass/fail gate                 |
| self-improver      | all skills            | `improvement_suggestions` → skill quality upgrades   |
| category-designer  | monopoly-niche-finder | `category_definition` → reframe the niche            |
| category-designer  | grand-slam-offer      | `category_framing` → position offer as category king |

## chain_metadata

Every skill output includes this metadata block for agent orchestration:

```yaml
chain_metadata:
  skill_slug: string # e.g., "affiliate-program-search"
  stage: string # e.g., "research"
  timestamp: string # ISO 8601
  suggested_next: string[] # e.g., ["viral-post-writer", "landing-page-creator"]
```

Agents use `suggested_next` to auto-chain skills without user intervention. The flywheel ensures `suggested_next` for S6 skills always includes S1 skills.
