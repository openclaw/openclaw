"""
test_pipeline.py — Unit tests for pipeline pure functions (no LLM calls).

Tests:
- discovery_filter: score_text
- knowledge_connector: extract_keywords, compute_similarity
- note_atomizer: jaccard_similarity, extract_keywords, extract_tickers,
                 content_hash, body_line_count, parse_frontmatter, render_frontmatter
- vault_reeval: parse_note, analyze_distribution
- keyword_tuner: extract_keywords_from_text, apply_tuning
- idea_collector: build_issue_md, build_summary
- shared.classify: classify_by_text, classify_by_tags, get_sector_label (→ test_classify.py)
"""
import json
from pathlib import Path

import pytest

from pipeline import discovery_filter as df
from pipeline import knowledge_connector as kc
from pipeline import note_atomizer as na
from pipeline import vault_reeval as vr
from pipeline import keyword_tuner as kt
from pipeline import idea_collector as ic
from shared.classify import classify_by_tags, classify_by_text, get_sector_label


# ============================================================
# discovery_filter: score_text
# ============================================================

class TestScoreText:
    def test_empty_string_returns_zero(self):
        score, matched = df.score_text("")
        assert score == 0
        assert matched == []

    def test_none_returns_zero(self):
        score, matched = df.score_text(None)
        assert score == 0

    def test_range_0_to_10(self):
        # Extreme keyword-rich text should still cap at 10
        text = "etf conviction 섹터 편입 리밸런싱 아키텍처 병목 인사이트 가설 실험 원칙 제텔카스텐 원자노트 발견 " * 5
        score, _ = df.score_text(text)
        assert 0 <= score <= 10

    def test_keyword_matching(self):
        score, matched = df.score_text("ETF 편입 기준과 conviction 분석")
        assert score > 0
        assert "etf" in matched
        assert "편입" in matched
        assert "conviction" in matched

    def test_length_bonus(self):
        short = "etf"
        long_text = "etf " + "a" * 300
        score_short, _ = df.score_text(short)
        score_long, _ = df.score_text(long_text)
        assert score_long > score_short

    def test_url_bonus(self):
        without_url = "인사이트 가설"
        with_url = "인사이트 가설 https://example.com"
        s1, _ = df.score_text(without_url)
        s2, _ = df.score_text(with_url)
        assert s2 == s1 + 1


# ============================================================
# knowledge_connector: extract_keywords, compute_similarity
# ============================================================

class TestKcExtractKeywords:
    def test_empty_string(self):
        assert kc.extract_keywords("") == set()

    def test_korean_extraction(self):
        kw = kc.extract_keywords("반도체 수익률 분석 리포트")
        assert "반도체" in kw
        assert "수익률" in kw

    def test_english_extraction(self):
        kw = kc.extract_keywords("machine learning pipeline architecture")
        assert "machine" in kw
        assert "learning" in kw
        assert "pipeline" in kw

    def test_stopwords_filtered(self):
        kw = kc.extract_keywords("the and for this that 하는 있는")
        assert len(kw) == 0

    def test_short_english_words_filtered(self):
        # Words < 3 chars should be excluded
        kw = kc.extract_keywords("AI is ok")
        assert "is" not in kw
        assert "ok" not in kw


class TestComputeSimilarity:
    def test_identical_sets(self):
        s = {"a", "b", "c"}
        assert kc.compute_similarity(s, s) == 1.0

    def test_disjoint_sets(self):
        assert kc.compute_similarity({"a", "b"}, {"c", "d"}) == 0.0

    def test_empty_set(self):
        assert kc.compute_similarity(set(), {"a"}) == 0.0
        assert kc.compute_similarity({"a"}, set()) == 0.0

    def test_partial_overlap(self):
        sim = kc.compute_similarity({"a", "b", "c"}, {"b", "c", "d"})
        # Jaccard: |{b,c}| / |{a,b,c,d}| = 2/4 = 0.5
        assert sim == pytest.approx(0.5)


# ============================================================
# note_atomizer: jaccard_similarity, extract_keywords, etc.
# ============================================================

class TestNaJaccardSimilarity:
    def test_identical(self):
        assert na.jaccard_similarity({"a", "b"}, {"a", "b"}) == 1.0

    def test_disjoint(self):
        assert na.jaccard_similarity({"a"}, {"b"}) == 0.0

    def test_empty(self):
        assert na.jaccard_similarity(set(), {"a"}) == 0.0

    def test_partial(self):
        sim = na.jaccard_similarity({"a", "b", "c"}, {"a", "b", "d"})
        assert sim == pytest.approx(2.0 / 4.0)


class TestNaExtractKeywords:
    def test_empty(self):
        assert na.extract_keywords("") == set()

    def test_mixed(self):
        kw = na.extract_keywords("NVDA 반도체 semiconductor analysis")
        assert "반도체" in kw
        assert "semiconductor" in kw
        assert "analysis" in kw


class TestContentHash:
    def test_deterministic(self):
        h1 = na.content_hash("hello world")
        h2 = na.content_hash("hello world")
        assert h1 == h2

    def test_different_inputs(self):
        h1 = na.content_hash("hello")
        h2 = na.content_hash("world")
        assert h1 != h2


class TestBodyLineCount:
    def test_empty(self):
        assert na.body_line_count("") == 0

    def test_headers_excluded(self):
        assert na.body_line_count("# Header\n## Subheader\nContent line") == 1

    def test_seed_note_excluded(self):
        assert na.body_line_count("(registry에서 생성된 시드 노트)") == 0

    def test_blank_lines_excluded(self):
        assert na.body_line_count("Line 1\n\n\nLine 2") == 2


class TestExtractTickers:
    def test_korean_tickers(self):
        tickers = na.extract_tickers("삼성전자와 SK바이오 분석")
        assert "삼성전자" in tickers
        # Note: "SK바이오" matches the pattern via 바이오 suffix

    def test_us_tickers(self):
        tickers = na.extract_tickers("NVDA and TSLA are rallying, but XYZ is not known")
        assert "NVDA" in tickers
        assert "TSLA" in tickers
        assert "XYZ" not in tickers  # Not in known_tickers

    def test_empty(self):
        assert na.extract_tickers("") == set()


class TestParseFrontmatter:
    def test_with_frontmatter(self, tmp_path):
        f = tmp_path / "note.md"
        f.write_text('---\ntitle: "Test Note"\ntags: ["a", "b"]\n---\nBody content here.')
        meta, body = na.parse_frontmatter(f)
        assert meta["title"] == "Test Note"
        assert meta["tags"] == ["a", "b"]
        assert "Body content" in body

    def test_without_frontmatter(self, tmp_path):
        f = tmp_path / "note.md"
        f.write_text("Just plain content")
        meta, body = na.parse_frontmatter(f)
        assert meta == {}
        assert "Just plain content" in body

    def test_nonexistent_file(self, tmp_path):
        f = tmp_path / "missing.md"
        meta, body = na.parse_frontmatter(f)
        assert meta == {}
        assert body == ""


class TestRenderFrontmatter:
    def test_basic(self):
        meta = {"title": "My Note", "date": "2026-01-01", "tags": ["a", "b"]}
        result = na.render_frontmatter(meta)
        assert result.startswith("---")
        assert result.endswith("---")
        assert '"My Note"' in result
        assert '["a", "b"]' in result

    def test_key_ordering(self):
        meta = {"sector": "S10", "title": "First", "date": "2026-01-01"}
        result = na.render_frontmatter(meta)
        lines = result.split("\n")
        # title should come before sector in key_order
        title_idx = next(i for i, l in enumerate(lines) if "title:" in l)
        sector_idx = next(i for i, l in enumerate(lines) if "sector:" in l)
        assert title_idx < sector_idx


class TestClassifyByText:
    def test_without_classification(self):
        result = classify_by_text("NVDA 반도체 분석")
        assert result["sector"] == "UNCLASSIFIED"

    def test_with_classification(self):
        classification = {
            "sectors": {
                "S10": {
                    "label": "반도체/기술",
                    "industry_groups": {
                        "IG1010": {
                            "label": "반도체",
                            "industries": {
                                "I101010": {
                                    "label": "반도체 장비",
                                    "tags": ["반도체", "semiconductor", "NVDA"]
                                }
                            }
                        }
                    }
                }
            }
        }
        result = classify_by_text("NVDA 반도체 분석", classification=classification)
        assert result["sector"] == "S10"


class TestGetSectorLabel:
    def test_found(self):
        classification = {"sectors": {"S10": {"label": "반도체/기술"}}}
        assert get_sector_label(classification, "S10") == "반도체/기술"

    def test_not_found(self):
        classification = {"sectors": {}}
        assert get_sector_label(classification, "S99") == "S99"

    def test_no_classification(self):
        assert get_sector_label(None, "S10") == "S10"


# ============================================================
# vault_reeval: parse_note, classify_by_tags, analyze_distribution
# ============================================================

class TestParseNote:
    def test_with_frontmatter(self, tmp_path):
        f = tmp_path / "note.md"
        f.write_text('---\ntags: ["반도체", "ETF"]\nsector: "S10"\nzk_type: "concept"\n---\n\nBody with [[link]].')
        note = vr.parse_note(f)
        assert note is not None
        assert "반도체" in note["tags"]
        assert note["sector"] == "S10"
        assert "link" in note["links"]

    def test_without_frontmatter(self, tmp_path):
        f = tmp_path / "plain.md"
        f.write_text("Just text with [[another link]]")
        note = vr.parse_note(f)
        assert note["tags"] == []
        assert "another link" in note["links"]

    def test_nonexistent(self, tmp_path):
        f = tmp_path / "missing.md"
        assert vr.parse_note(f) is None


class TestClassifyByTags:
    def _classification(self):
        return {
            "sectors": {
                "S10": {
                    "label": "반도체/기술",
                    "industry_groups": {
                        "IG1010": {
                            "label": "반도체",
                            "industries": {
                                "I101010": {
                                    "label": "반도체 장비",
                                    "tags": ["반도체", "semiconductor"]
                                }
                            }
                        }
                    }
                },
                "S20": {
                    "label": "바이오",
                    "industry_groups": {
                        "IG2010": {
                            "label": "바이오텍",
                            "industries": {
                                "I201010": {
                                    "label": "바이오 의약",
                                    "tags": ["바이오", "biotech"]
                                }
                            }
                        }
                    }
                }
            }
        }

    def test_matching_tags(self):
        matches = classify_by_tags(["반도체", "투자"], self._classification())
        assert len(matches) >= 1
        assert matches[0]["sector"] == "S10"

    def test_no_matching_tags(self):
        matches = classify_by_tags(["unrelated", "random"], self._classification())
        assert matches == []

    def test_multiple_matches(self):
        matches = classify_by_tags(["반도체", "바이오"], self._classification())
        assert len(matches) == 2

    def test_case_insensitive(self):
        matches = classify_by_tags(["Semiconductor"], self._classification())
        assert len(matches) >= 1


class TestAnalyzeDistribution:
    def _classification(self):
        return {
            "sectors": {
                "S10": {
                    "label": "반도체/기술",
                    "industry_groups": {
                        "IG1010": {
                            "label": "반도체",
                            "industries": {
                                "I101010": {
                                    "label": "장비",
                                    "tags": ["반도체"]
                                }
                            }
                        }
                    }
                }
            }
        }

    def test_basic_distribution(self):
        notes = [
            {"tags": ["반도체"], "links": ["a"]},
            {"tags": ["반도체"], "links": []},
            {"tags": ["unknown"], "links": []},
        ]
        stats = vr.analyze_distribution(notes, self._classification())
        assert stats["total_notes"] == 3
        assert stats["classified"] == 2
        assert stats["unclassified"] == 1
        assert stats["unlinked"] == 2

    def test_empty_notes(self):
        stats = vr.analyze_distribution([], self._classification())
        assert stats["total_notes"] == 0
        assert stats["classified"] == 0


# ============================================================
# keyword_tuner: extract_keywords_from_text, apply_tuning
# ============================================================

class TestKtExtractKeywords:
    def test_basic(self):
        kw = kt.extract_keywords_from_text("machine learning 반도체 분석")
        assert "machine" in kw
        assert "반도체" in kw

    def test_stopwords_removed(self):
        kw = kt.extract_keywords_from_text("the and for 하는 있는")
        assert len(kw) == 0


class TestApplyTuning:
    def test_positive_verdict_adds_keywords(self):
        idea_sources = {
            "focus_areas": {
                "semiconductor": {
                    "keywords": ["반도체"],
                    "current_bottlenecks": ["supply chain"]
                }
            }
        }
        evaluations = [{
            "area": "semiconductor",
            "verdict": "positive",
            "bottleneck": "supply chain",
            "hypothesis_id": "H1"
        }]
        changes = kt.apply_tuning(idea_sources, evaluations, dry_run=True)
        assert len(changes) >= 1

    def test_negative_verdict_refines_bottleneck(self):
        idea_sources = {
            "focus_areas": {
                "bio": {
                    "keywords": ["바이오"],
                    "current_bottlenecks": ["clinical trial delay"]
                }
            }
        }
        evaluations = [{
            "area": "bio",
            "verdict": "negative",
            "bottleneck": "clinical trial delay",
        }]
        changes = kt.apply_tuning(idea_sources, evaluations, dry_run=True)
        assert any("재정의" in c for c in changes)
        assert "재검토 필요" in idea_sources["focus_areas"]["bio"]["current_bottlenecks"][0]

    def test_unknown_area_ignored(self):
        idea_sources = {"focus_areas": {"known": {"keywords": []}}}
        evaluations = [{"area": "unknown", "verdict": "positive", "bottleneck": "x"}]
        changes = kt.apply_tuning(idea_sources, evaluations, dry_run=True)
        assert changes == []


# ============================================================
# idea_collector: build_issue_md, build_summary
# ============================================================

class TestBuildIssueMd:
    def test_basic_output(self):
        issue = {
            "number": 42,
            "title": "Fix bug",
            "url": "https://github.com/test/repo/issues/42",
            "body": "Description of the bug",
            "labels": [{"name": "bug"}],
            "closedAt": "2026-01-15T12:00:00Z",
        }
        md = ic.build_issue_md(issue)
        assert "# [42] Fix bug" in md
        assert "bug" in md
        assert "2026-01-15" in md
        assert "---" in md

    def test_with_comments(self):
        issue = {"number": 1, "title": "Test", "labels": []}
        comments = [{"author": "user1", "body": "Nice fix"}]
        md = ic.build_issue_md(issue, comments)
        assert "@user1" in md
        assert "Nice fix" in md


class TestBuildSummary:
    def test_empty_returns_none(self):
        assert ic.build_summary([]) is None

    def test_nonempty_returns_string(self):
        issues = [{"number": 1, "title": "Test", "url": "https://example.com"}]
        summary = ic.build_summary(issues)
        assert summary is not None
        assert "1건" in summary
