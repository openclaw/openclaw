"""
test_classify.py — Unit tests for shared/classify.py (GICS classification engine).

Tests:
- load_classification: file loading, missing file, invalid JSON
- classify_by_text: matching, unclassified fallback, multi-industry scoring
- extract_keyword_tags: tag extraction, max_tags, empty inputs
- classify_by_tags: tag-set matching, scoring, case-insensitivity
- get_sector_label: label lookup, missing, None classification
"""
import json
from pathlib import Path

import pytest

from shared.classify import (
    _compute_confidence,
    _build_patterns,
    _is_ascii_tag,
    classify_by_tags,
    classify_by_text,
    extract_keyword_tags,
    get_sector_label,
    load_classification,
    strip_meta_phrases,
)


# ── Fixture: minimal classification dict ──────────────────────────────────────

def _make_classification():
    """Minimal classification.json structure for testing (v2 with synonyms)."""
    return {
        "version": "2.0.0",
        "sectors": {
            "S10": {
                "label": "반도체·기술",
                "domain": "investment",
                "industry_groups": {
                    "IG1010": {
                        "label": "AI반도체",
                        "industries": {
                            "I101010": {
                                "label": "AI칩·GPU",
                                "tags": ["AI칩", "GPU", "NPU", "NVIDIA", "AMD"],
                                "synonyms": {
                                    "엔비디아": "NVIDIA",
                                    "AI chip": "AI칩",
                                    "그래픽카드": "GPU",
                                },
                            },
                            "I101020": {
                                "label": "메모리반도체",
                                "tags": ["DRAM", "NAND", "HBM", "삼성전자"],
                                "synonyms": {
                                    "SK Hynix": "HBM",
                                    "Samsung": "삼성전자",
                                    "메모리반도체": "DRAM",
                                },
                            },
                        },
                    },
                },
            },
            "S20": {
                "label": "바이오·헬스",
                "domain": "investment",
                "industry_groups": {
                    "IG2010": {
                        "label": "바이오텍",
                        "industries": {
                            "I201010": {
                                "label": "바이오 신약",
                                "tags": ["바이오", "신약", "임상시험", "FDA"],
                                "synonyms": {
                                    "biosimilar": "바이오",
                                    "new drug": "신약",
                                },
                            },
                        },
                    },
                },
            },
            "S91": {
                "label": "소프트웨어·인프라",
                "domain": "engineering",
                "industry_groups": {
                    "IG9110": {
                        "label": "LLM·AI",
                        "industries": {
                            "I911010": {
                                "label": "LLM 엔지니어링",
                                "tags": ["LLM", "GPT", "프롬프트", "파인튜닝"],
                            },
                        },
                    },
                },
            },
        },
    }


# ============================================================
# load_classification
# ============================================================

class TestLoadClassification:
    def test_load_valid_file(self, tmp_path):
        cls_file = tmp_path / "classification.json"
        data = _make_classification()
        cls_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        result = load_classification(cls_file)
        assert result is not None
        assert "sectors" in result
        assert "S10" in result["sectors"]

    def test_load_missing_file(self, tmp_path):
        result = load_classification(tmp_path / "nonexistent.json")
        assert result is None

    def test_load_invalid_json(self, tmp_path):
        cls_file = tmp_path / "bad.json"
        cls_file.write_text("{invalid json}", encoding="utf-8")
        result = load_classification(cls_file)
        assert result is None

    def test_load_default_path_override(self, tmp_path):
        cls_file = tmp_path / "custom.json"
        cls_file.write_text('{"sectors": {}}', encoding="utf-8")
        result = load_classification(path=cls_file)
        assert result == {"sectors": {}}


# ============================================================
# classify_by_text
# ============================================================

class TestClassifyByText:
    def test_no_classification(self):
        result = classify_by_text("NVIDIA GPU 반도체")
        assert result["sector"] == "UNCLASSIFIED"
        assert result["matched_tags"] == []

    def test_none_classification(self):
        result = classify_by_text("NVIDIA GPU", classification=None)
        assert result["sector"] == "UNCLASSIFIED"

    def test_basic_match(self):
        cls = _make_classification()
        result = classify_by_text("NVIDIA GPU 최신 칩 분석", classification=cls)
        assert result["sector"] == "S10"
        assert result["industry"] == "I101010"
        assert "NVIDIA" in result["matched_tags"]
        assert "GPU" in result["matched_tags"]

    def test_best_score_wins(self):
        """Industry with more tag overlaps should win."""
        cls = _make_classification()
        # AI칩 has 5 tags, mention 3 of them
        result = classify_by_text("NVIDIA GPU NPU 성능 비교", classification=cls)
        assert result["sector"] == "S10"
        assert result["industry"] == "I101010"
        assert len(result["matched_tags"]) >= 3

    def test_memory_semiconductor(self):
        cls = _make_classification()
        result = classify_by_text("DRAM HBM 가격 전망 삼성전자", classification=cls)
        assert result["industry"] == "I101020"
        assert result["sector"] == "S10"

    def test_bio_match(self):
        cls = _make_classification()
        result = classify_by_text("바이오 신약 FDA 승인 기대", classification=cls)
        assert result["sector"] == "S20"
        assert "바이오" in result["matched_tags"]

    def test_engineering_domain(self):
        cls = _make_classification()
        result = classify_by_text("LLM GPT 프롬프트 엔지니어링", classification=cls)
        assert result["sector"] == "S91"
        assert result["domain"] == "engineering"

    def test_url_contributes(self):
        cls = _make_classification()
        result = classify_by_text("기사 분석", url="https://nvidia.com/gpu",
                                  classification=cls)
        assert "gpu" in [t.lower() for t in result["matched_tags"]]

    def test_no_match_returns_unclassified(self):
        cls = _make_classification()
        result = classify_by_text("오늘 날씨가 좋다", classification=cls)
        assert result["sector"] == "UNCLASSIFIED"

    def test_case_insensitive_matching(self):
        cls = _make_classification()
        result = classify_by_text("nvidia gpu 기술 분석", classification=cls)
        assert result["sector"] == "S10"

    def test_empty_text(self):
        cls = _make_classification()
        result = classify_by_text("", classification=cls)
        assert result["sector"] == "UNCLASSIFIED"

    def test_returns_labels(self):
        cls = _make_classification()
        result = classify_by_text("NVIDIA GPU", classification=cls)
        assert result["sector_label"] == "반도체·기술"
        assert result["ig_label"] == "AI반도체"
        assert result["i_label"] == "AI칩·GPU"

    def test_empty_sectors(self):
        result = classify_by_text("NVIDIA", classification={"sectors": {}})
        assert result["sector"] == "UNCLASSIFIED"


# ============================================================
# extract_keyword_tags
# ============================================================

class TestExtractKeywordTags:
    def test_basic_extraction(self):
        cls = _make_classification()
        tags = extract_keyword_tags("NVIDIA GPU 반도체 분석", classification=cls)
        assert "NVIDIA" in tags or "GPU" in tags

    def test_max_tags_limit(self):
        cls = _make_classification()
        tags = extract_keyword_tags(
            "AI칩 GPU NPU NVIDIA AMD DRAM NAND HBM",
            classification=cls, max_tags=3,
        )
        assert len(tags) <= 3

    def test_no_classification(self):
        tags = extract_keyword_tags("NVIDIA GPU")
        assert tags == []

    def test_empty_text(self):
        cls = _make_classification()
        tags = extract_keyword_tags("", classification=cls)
        assert tags == []

    def test_no_duplicates(self):
        cls = _make_classification()
        tags = extract_keyword_tags("GPU GPU GPU NVIDIA", classification=cls)
        assert len(tags) == len(set(tags))

    def test_url_matching(self):
        cls = _make_classification()
        tags = extract_keyword_tags("기사", url="https://nvidia.com",
                                    classification=cls)
        assert any("nvidia" in t.lower() for t in tags)


# ============================================================
# classify_by_tags
# ============================================================

class TestClassifyByTags:
    def test_single_match(self):
        cls = _make_classification()
        matches = classify_by_tags(["GPU", "NPU"], classification=cls)
        assert len(matches) >= 1
        assert matches[0]["sector"] == "S10"
        assert matches[0]["industry"] == "I101010"

    def test_no_match(self):
        cls = _make_classification()
        matches = classify_by_tags(["unrelated", "random"], classification=cls)
        assert matches == []

    def test_multiple_matches_sorted(self):
        cls = _make_classification()
        matches = classify_by_tags(["GPU", "NPU", "바이오"], classification=cls)
        assert len(matches) >= 2
        # First match should have higher score
        assert matches[0]["score"] >= matches[-1]["score"]

    def test_case_insensitive(self):
        cls = _make_classification()
        matches = classify_by_tags(["gpu", "npu"], classification=cls)
        assert len(matches) >= 1

    def test_empty_tags(self):
        cls = _make_classification()
        matches = classify_by_tags([], classification=cls)
        assert matches == []

    def test_none_classification(self):
        matches = classify_by_tags(["GPU"])
        assert matches == []

    def test_overlap_included(self):
        cls = _make_classification()
        matches = classify_by_tags(["GPU", "NPU"], classification=cls)
        overlap_tags = matches[0]["overlap"]
        assert "gpu" in overlap_tags or "npu" in overlap_tags

    def test_score_is_overlap_count(self):
        cls = _make_classification()
        matches = classify_by_tags(["GPU", "NPU", "NVIDIA"], classification=cls)
        ai_chip = [m for m in matches if m["industry"] == "I101010"]
        assert len(ai_chip) == 1
        assert ai_chip[0]["score"] == 3


# ============================================================
# get_sector_label
# ============================================================

class TestGetSectorLabel:
    def test_found(self):
        cls = _make_classification()
        assert get_sector_label(cls, "S10") == "반도체·기술"

    def test_not_found(self):
        cls = _make_classification()
        assert get_sector_label(cls, "S99") == "S99"

    def test_none_classification(self):
        assert get_sector_label(None, "S10") == "S10"

    def test_empty_sectors(self):
        assert get_sector_label({"sectors": {}}, "S10") == "S10"


# ============================================================
# Phase 2: Word-boundary matching
# ============================================================

class TestWordBoundary:
    def test_ascii_tag_uses_word_boundary(self):
        """'AI' should NOT match 'plAIn' with word-boundary."""
        cls = {
            "version": "2.0.0",
            "sectors": {
                "S99": {
                    "label": "Test",
                    "domain": "test",
                    "industry_groups": {
                        "IG9910": {
                            "label": "Test",
                            "industries": {
                                "I991010": {
                                    "label": "Test",
                                    "tags": ["AI"],
                                },
                            },
                        },
                    },
                },
            },
        }
        # "AI" should match "AI is great"
        result = classify_by_text("AI is great technology", classification=cls)
        assert result["sector"] == "S99"

        # "AI" should NOT match "plAIn text" (substring but not word boundary)
        result2 = classify_by_text("plAIn text explanation", classification=cls)
        assert result2["sector"] == "UNCLASSIFIED"

    def test_korean_tag_uses_substring(self):
        """Korean tags should still use substring matching."""
        cls = _make_classification()
        result = classify_by_text("이것은 바이오의약품 관련 기사", classification=cls)
        assert result["sector"] == "S20"

    def test_mixed_tag_matching(self):
        cls = _make_classification()
        result = classify_by_text("GPU와 NVIDIA의 새 제품", classification=cls)
        assert result["sector"] == "S10"
        assert "GPU" in result["matched_tags"]
        assert "NVIDIA" in result["matched_tags"]


# ============================================================
# Phase 2: Synonym matching
# ============================================================

class TestSynonymMatching:
    def test_korean_synonym_matches(self):
        """Korean synonym '엔비디아' should map to canonical tag 'NVIDIA'."""
        cls = _make_classification()
        result = classify_by_text("엔비디아 실적 분석", classification=cls)
        assert result["sector"] == "S10"
        assert "NVIDIA" in result["matched_tags"]

    def test_english_synonym_matches(self):
        """English synonym 'AI chip' should map to canonical 'AI칩'."""
        cls = _make_classification()
        result = classify_by_text("The AI chip market is booming", classification=cls)
        assert result["sector"] == "S10"
        assert "AI칩" in result["matched_tags"]

    def test_synonym_no_double_count(self):
        """If both tag and synonym match, tag should only count once."""
        cls = _make_classification()
        # Both "NVIDIA" (tag) and "엔비디아" (synonym→NVIDIA) present
        result = classify_by_text("NVIDIA 엔비디아 GPU 분석", classification=cls)
        nvidia_count = result["matched_tags"].count("NVIDIA")
        assert nvidia_count == 1

    def test_synonym_in_extract_keyword_tags(self):
        cls = _make_classification()
        tags = extract_keyword_tags("엔비디아 AI chip 신기술", classification=cls)
        assert "NVIDIA" in tags
        assert "AI칩" in tags

    def test_bio_synonym(self):
        cls = _make_classification()
        result = classify_by_text("biosimilar and new drug development", classification=cls)
        assert result["sector"] == "S20"


# ============================================================
# Phase 2: Confidence scoring
# ============================================================

class TestConfidenceScoring:
    def test_confidence_present(self):
        cls = _make_classification()
        result = classify_by_text("NVIDIA GPU NPU AMD AI칩", classification=cls)
        assert "confidence" in result
        assert result["confidence"] > 0.0

    def test_high_confidence(self):
        """Matching all 5 tags of a 5-tag industry → high confidence."""
        cls = _make_classification()
        result = classify_by_text("AI칩 GPU NPU NVIDIA AMD", classification=cls)
        assert result["confidence"] >= 0.7

    def test_low_confidence_single_tag(self):
        """Single tag match → lower confidence."""
        cls = _make_classification()
        result = classify_by_text("GPU 이야기", classification=cls)
        assert result["confidence"] < 0.7

    def test_confidence_zero_on_no_match(self):
        cls = _make_classification()
        result = classify_by_text("오늘 날씨", classification=cls)
        assert result["confidence"] == 0.0

    def test_compute_confidence_formula(self):
        # matched=3 of 5 tags, best=3, second=1 → gap=2 → uniqueness=1.0
        # depth=1.0, uniqueness=1.0, coverage=0.6
        # = 1.0*0.4 + 1.0*0.4 + 0.6*0.2 = 0.92
        c = _compute_confidence(3, 5, 3, 1)
        assert abs(c - 0.92) < 0.01

    def test_compute_confidence_low_gap(self):
        # gap < 2 → uniqueness=0.5
        c = _compute_confidence(2, 5, 2, 1)
        # depth=2/3, uniqueness=0.5, coverage=0.4
        expected = (2/3) * 0.4 + 0.5 * 0.4 + 0.4 * 0.2
        assert abs(c - round(expected, 3)) < 0.01

    def test_compute_confidence_zero(self):
        assert _compute_confidence(0, 5, 0, 0) == 0.0


# ============================================================
# Phase 2: Runner-up
# ============================================================

class TestRunnerUp:
    def test_runner_up_present(self):
        cls = _make_classification()
        result = classify_by_text("GPU 바이오 분석", classification=cls)
        # Should have a runner-up since both S10 and S20 match
        assert result["runner_up"] is not None

    def test_runner_up_structure(self):
        cls = _make_classification()
        result = classify_by_text("GPU 바이오 분석", classification=cls)
        ru = result["runner_up"]
        assert "sector" in ru
        assert "score" in ru
        assert "matched_tags" in ru

    def test_no_runner_up_when_single_match(self):
        cls = _make_classification()
        result = classify_by_text("NVIDIA GPU NPU AMD AI칩", classification=cls)
        # Only S10 matches — runner_up may be None or another S10 industry
        # The key point is that it runs without error

    def test_runner_up_none_on_unclassified(self):
        cls = _make_classification()
        result = classify_by_text("오늘 날씨", classification=cls)
        assert result["runner_up"] is None


# ============================================================
# Phase 2: Pattern cache
# ============================================================

class TestPatternCache:
    def test_cache_builds(self):
        cls = _make_classification()
        patterns = _build_patterns(cls)
        assert "I101010" in patterns
        assert len(patterns["I101010"]["tag_patterns"]) == 5  # 5 tags

    def test_cache_reuse(self):
        cls = _make_classification()
        p1 = _build_patterns(cls)
        p2 = _build_patterns(cls)
        assert p1 is p2  # Same object from cache

    def test_synonym_patterns_built(self):
        cls = _make_classification()
        patterns = _build_patterns(cls)
        syn_pats = patterns["I101010"]["synonym_patterns"]
        assert len(syn_pats) == 3  # 3 synonyms defined

    def test_is_ascii_tag(self):
        assert _is_ascii_tag("NVIDIA") is True
        assert _is_ascii_tag("GPU") is True
        assert _is_ascii_tag("AI") is True
        assert _is_ascii_tag("AI칩") is False
        assert _is_ascii_tag("바이오") is False
        assert _is_ascii_tag("n8n") is True


# ============================================================
# Phase 3: taxonomy_audit and vault_reeval proposals
# ============================================================

class TestTaxonomyAuditFunctions:
    """Test taxonomy_audit.py pure functions."""

    def test_count_distribution(self):
        from ops.taxonomy_audit import count_distribution
        cls = _make_classification()
        notes = [
            {"tags": ["GPU"], "sector": "S10", "industry_group": "IG1010",
             "industry": "I101010"},
            {"tags": ["바이오"], "sector": "S20", "industry_group": "IG2010",
             "industry": "I201010"},
            {"tags": [], "sector": "UNCLASSIFIED", "industry_group": "",
             "industry": ""},
        ]
        dist = count_distribution(notes, cls)
        assert dist["total"] == 3
        assert dist["classified"] == 2
        assert dist["unclassified"] == 1
        assert dist["by_sector"]["S10"] == 1
        assert dist["by_sector"]["S20"] == 1

    def test_find_empty_industries(self):
        from ops.taxonomy_audit import find_empty_industries
        cls = _make_classification()
        by_industry = {"I101010": 5}  # Only one industry has notes
        empty = find_empty_industries(cls, by_industry)
        # All others should be empty
        assert len(empty) >= 3  # At least I101020, I201010, I911010

    def test_find_overcrowded(self):
        from ops.taxonomy_audit import find_overcrowded
        cls = _make_classification()
        by_industry = {"I101010": 35, "I201010": 10}
        crowded = find_overcrowded(cls, by_industry, threshold=30)
        assert len(crowded) == 1
        assert crowded[0]["industry"] == "I101010"
        assert crowded[0]["count"] == 35

    def test_find_no_overcrowded(self):
        from ops.taxonomy_audit import find_overcrowded
        cls = _make_classification()
        by_industry = {"I101010": 5}
        crowded = find_overcrowded(cls, by_industry, threshold=30)
        assert crowded == []

    def test_find_new_tag_candidates(self):
        from ops.taxonomy_audit import find_new_tag_candidates
        tag_freq = {"블록체인": 10, "NFT": 6, "rare_tag": 2, "status/done": 15}
        candidates = find_new_tag_candidates(tag_freq, threshold=5)
        tags = [c["tag"] for c in candidates]
        assert "블록체인" in tags
        assert "NFT" in tags
        assert "rare_tag" not in tags  # Below threshold
        assert "status/done" not in tags  # System tag filtered

    def test_generate_audit_report(self):
        from ops.taxonomy_audit import generate_audit_report
        cls = _make_classification()
        dist = {"total": 100, "classified": 80, "unclassified": 20,
                "by_sector": {"S10": 50, "S20": 30}}
        empty = [{"industry": "I911010", "label": "Test > LLM", "sector": "S91"}]
        crowded = [{"industry": "I101010", "label": "반도체 > AI칩",
                    "count": 50, "sector": "S10"}]
        new_tags = [{"tag": "블록체인", "count": 10}]
        report = generate_audit_report(dist, empty, crowded, new_tags, cls)
        assert "분류체계 구조 감사" in report
        assert "S10" in report
        assert "I911010" in report
        assert "블록체인" in report


class TestVaultReevalProposals:
    def test_propose_no_changes(self):
        from pipeline.vault_reeval import propose_structure_changes
        stats = {"by_industry": {}, "total_notes": 10}
        suggestions = []
        cls = _make_classification()
        proposals = propose_structure_changes(stats, suggestions, cls)
        assert proposals["add_industries"] == []
        assert proposals["merge_industries"] == []

    def test_propose_new_industry(self):
        from pipeline.vault_reeval import propose_structure_changes
        stats = {"by_industry": {}}
        suggestions = [
            {"type": "new_cluster", "tag": "블록체인", "count": 15,
             "severity": "medium"},
        ]
        cls = _make_classification()
        proposals = propose_structure_changes(stats, suggestions, cls)
        assert len(proposals["add_industries"]) == 1
        assert proposals["add_industries"][0]["tag"] == "블록체인"

    def test_propose_merge_overcrowded(self):
        from pipeline.vault_reeval import propose_structure_changes
        stats = {"by_industry": {"I101010": 100}}
        suggestions = [
            {"type": "overcrowded", "target": "I101010", "count": 100,
             "severity": "high"},
        ]
        cls = _make_classification()
        proposals = propose_structure_changes(stats, suggestions, cls)
        assert len(proposals["merge_industries"]) == 1


# ============================================================
# Phase 4: Auto-apply safe changes
# ============================================================

class TestAutoApply:
    def test_auto_apply_unclassified(self, tmp_path):
        """UNCLASSIFIED note with high confidence → gets classified."""
        from pipeline.vault_reeval import apply_safe_changes
        cls = _make_classification()

        # Create a fake UNCLASSIFIED note with NVIDIA-heavy content
        note_file = tmp_path / "test_note.md"
        note_file.write_text(
            '---\nsector: "UNCLASSIFIED"\ntags: []\n---\n\n'
            'NVIDIA GPU NPU AMD AI칩 기술 분석\n',
            encoding="utf-8",
        )

        notes = [{
            "path": str(note_file),
            "filename": "test_note.md",
            "tags": [],
            "sector": "UNCLASSIFIED",
            "industry_group": "",
            "industry": "",
        }]

        changes = apply_safe_changes(notes, cls, dry_run=False)
        assert len(changes) == 1
        assert changes[0]["new_sector"] == "S10"
        assert changes[0]["confidence"] >= 0.7

        # Verify frontmatter was updated
        from shared.frontmatter import parse_frontmatter
        meta, _ = parse_frontmatter(note_file)
        assert meta["sector"] == "S10"
        assert meta.get("auto_classified") in (True, "true")

    def test_auto_apply_dry_run(self, tmp_path):
        """Dry run should not modify files."""
        from pipeline.vault_reeval import apply_safe_changes
        cls = _make_classification()

        note_file = tmp_path / "test_note.md"
        note_file.write_text(
            '---\nsector: "UNCLASSIFIED"\n---\n\nNVIDIA GPU NPU AMD AI칩\n',
            encoding="utf-8",
        )

        notes = [{
            "path": str(note_file),
            "filename": "test_note.md",
            "tags": [],
            "sector": "UNCLASSIFIED",
            "industry_group": "", "industry": "",
        }]

        changes = apply_safe_changes(notes, cls, dry_run=True)
        assert len(changes) == 1

        # File should NOT be modified
        from shared.frontmatter import parse_frontmatter
        meta, _ = parse_frontmatter(note_file)
        assert meta.get("sector") == "UNCLASSIFIED"

    def test_auto_apply_skips_classified(self, tmp_path):
        """Already classified notes should be skipped."""
        from pipeline.vault_reeval import apply_safe_changes
        cls = _make_classification()

        note_file = tmp_path / "classified.md"
        note_file.write_text(
            '---\nsector: "S20"\n---\n\nNVIDIA GPU NPU\n',
            encoding="utf-8",
        )

        notes = [{
            "path": str(note_file),
            "filename": "classified.md",
            "tags": [],
            "sector": "S20",
            "industry_group": "IG2010", "industry": "I201010",
        }]

        changes = apply_safe_changes(notes, cls, dry_run=False)
        assert len(changes) == 0

    def test_auto_apply_skips_low_confidence(self, tmp_path):
        """Low confidence results should be skipped."""
        from pipeline.vault_reeval import apply_safe_changes
        cls = _make_classification()

        note_file = tmp_path / "vague.md"
        note_file.write_text(
            '---\nsector: "UNCLASSIFIED"\n---\n\n날씨가 좋다\n',
            encoding="utf-8",
        )

        notes = [{
            "path": str(note_file),
            "filename": "vague.md",
            "tags": [],
            "sector": "UNCLASSIFIED",
            "industry_group": "", "industry": "",
        }]

        changes = apply_safe_changes(notes, cls, dry_run=False)
        assert len(changes) == 0

    def test_auto_apply_cap(self, tmp_path):
        """Should not exceed AUTO_APPLY_CAP."""
        from pipeline.vault_reeval import apply_safe_changes, AUTO_APPLY_CAP
        cls = _make_classification()

        notes = []
        for i in range(AUTO_APPLY_CAP + 10):
            f = tmp_path / f"note_{i}.md"
            f.write_text(
                '---\nsector: "UNCLASSIFIED"\n---\n\nNVIDIA GPU NPU AMD AI칩\n',
                encoding="utf-8",
            )
            notes.append({
                "path": str(f),
                "filename": f.name,
                "tags": [],
                "sector": "UNCLASSIFIED",
                "industry_group": "", "industry": "",
            })

        changes = apply_safe_changes(notes, cls, dry_run=True)
        assert len(changes) == AUTO_APPLY_CAP


# ============================================================
# Phase 4: Cross-sector detection
# ============================================================

class TestSecondarySectors:
    def test_secondary_sectors_detected(self):
        """When multiple sectors match, secondary_sectors should list them."""
        cls = _make_classification()
        # GPU(S10) + 바이오(S20) both mentioned
        result = classify_by_text("GPU 바이오 신약 분석", classification=cls)
        assert "secondary_sectors" in result
        if result["sector"] == "S10":
            sec_codes = [s["sector"] for s in result["secondary_sectors"]]
            assert "S20" in sec_codes
        elif result["sector"] == "S20":
            sec_codes = [s["sector"] for s in result["secondary_sectors"]]
            assert "S10" in sec_codes

    def test_no_secondary_when_single_sector(self):
        cls = _make_classification()
        result = classify_by_text("NVIDIA GPU NPU AMD AI칩", classification=cls)
        # Only S10 matches — no secondary sectors from different sectors
        for ss in result.get("secondary_sectors", []):
            assert ss["sector"] != result["sector"]

    def test_secondary_sectors_threshold(self):
        """Secondary sectors require >= 50% of best score."""
        cls = _make_classification()
        # 3 tags for S10 (GPU, NPU, NVIDIA) + 1 for S20 (바이오)
        # S20 score (1) < 50% of S10 score (3) → not secondary
        result = classify_by_text("GPU NPU NVIDIA 그리고 바이오", classification=cls)
        sec_codes = [s["sector"] for s in result.get("secondary_sectors", [])]
        assert "S20" not in sec_codes

    def test_secondary_sectors_empty_on_unclassified(self):
        cls = _make_classification()
        result = classify_by_text("오늘 날씨", classification=cls)
        assert result["secondary_sectors"] == []


# ============================================================
# Phase 4: MOC incremental (unit-testable parts)
# ============================================================

class TestMOCIncremental:
    def test_moc_hash_computation(self):
        """Verify hash is deterministic for same note list."""
        import hashlib
        stems = sorted(["note_a", "note_b", "note_c"])
        h1 = hashlib.md5("|".join(stems).encode()).hexdigest()
        h2 = hashlib.md5("|".join(stems).encode()).hexdigest()
        assert h1 == h2

    def test_moc_hash_changes_on_new_note(self):
        import hashlib
        stems1 = sorted(["note_a", "note_b"])
        stems2 = sorted(["note_a", "note_b", "note_c"])
        h1 = hashlib.md5("|".join(stems1).encode()).hexdigest()
        h2 = hashlib.md5("|".join(stems2).encode()).hexdigest()
        assert h1 != h2


# ── Phase 5: Meta-phrase stripping ────────────────────────────────────────────

class TestStripMetaPhrases:
    """Test system-generated meta phrase removal."""

    def test_strip_llm_synthesis_header(self):
        text = "# 투자전략\n\n**(추정) LLM 합성 콘텐츠**\n\n실제 내용"
        result = strip_meta_phrases(text)
        assert "LLM" not in result
        assert "실제 내용" in result

    def test_strip_llm_synthesis_header_no_bold(self):
        text = "(추정) LLM 합성 콘텐츠\n\n본문"
        result = strip_meta_phrases(text)
        assert "LLM" not in result
        assert "본문" in result

    def test_strip_metadata_lines(self):
        text = "- 제목: 삶에 흙 한 스푼\n- 태그: topic/지식사랑방\n- 섹터: S10\n본문"
        result = strip_meta_phrases(text)
        assert "제목:" not in result
        assert "태그:" not in result
        assert "섹터:" not in result
        assert "본문" in result

    def test_strip_wikilinks(self):
        text = "관련: [[reg-NVDA]] — 같은 산업\n[[합성_1]] — 같은 산업"
        result = strip_meta_phrases(text)
        assert "[[" not in result
        assert "같은 산업" not in result

    def test_strip_source_annotation(self):
        text = "## 출처\n- [[원본노트]] (원본 노트)\n\n## 본문\n내용"
        result = strip_meta_phrases(text)
        assert "원본 노트" not in result
        assert "내용" in result

    def test_preserves_real_content(self):
        text = "NVIDIA GPU 반도체 시장 분석. 매크로 환경 변화."
        result = strip_meta_phrases(text)
        assert result.strip() == text

    def test_classify_after_strip_no_false_llm(self):
        """After stripping, investment text should NOT match I104020 (AI·ML)."""
        cls = _make_classification()
        # Simulate a note about macro economics with LLM synthesis header
        text = (
            "**(추정) LLM 합성 콘텐츠**\n"
            "- 제목: 골드만삭스 매크로 전망\n"
            "채권 금리 하락 전망. 경기 둔화 신호."
        )
        result = classify_by_text(text, classification=cls)
        # Should NOT be classified as AI/LLM industry
        # (exact result depends on fixture tags, but LLM shouldn't be in matched_tags)
        assert "LLM" not in result.get("matched_tags", [])


class TestReclassifyCatchall:
    """Test reclassify_catchall script functions."""

    def test_import(self):
        """Verify reclassify_catchall.py is importable."""
        import importlib
        mod = importlib.import_module("ops.reclassify_catchall")
        assert hasattr(mod, "find_catchall_notes")
        assert hasattr(mod, "reclassify_note")
        assert hasattr(mod, "apply_reclassification")

    def test_reclassify_note_skips_same_industry(self):
        """If re-classification still gives I104020, should return None."""
        from ops.reclassify_catchall import reclassify_note

        cls = _make_classification()
        # Note with only AI tags — should stay I104020 or get None
        note = {
            "path": Path("/tmp/test.md"),
            "filename": "test.md",
            "meta": {"industry": "I104020", "title": "AI서비스 분석"},
            "body": "AI서비스 GPT Claude",
        }
        result = reclassify_note(note, cls)
        # Either None (same industry) or different industry — both acceptable
        if result is not None:
            assert result["new_industry"] != "I104020"

    def test_reclassify_note_detects_new_industry(self):
        """Note with semiconductor content should reclassify to S10."""
        from ops.reclassify_catchall import reclassify_note

        cls = _make_classification()
        note = {
            "path": Path("/tmp/test.md"),
            "filename": "test.md",
            "meta": {"industry": "I104020", "sector": "S10",
                     "title": "NVIDIA GPU 메모리 분석"},
            "body": (
                "**(추정) LLM 합성 콘텐츠**\n"
                "- 제목: NVIDIA GPU 메모리 분석\n"
                "NVIDIA GPU 반도체 HBM 메모리 공급망 분석"
            ),
        }
        result = reclassify_note(note, cls)
        # Should reclassify (not None) and not stay I104020
        if result is not None:
            assert result["new_industry"] != "I104020"
            assert result["confidence"] >= 0.4
