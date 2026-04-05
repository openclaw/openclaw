"""Obsidian vault export — collects tagged .md files into a single Mega-source."""

import os

_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def export_vault_content() -> str:
    """Collects all .md files in the .obsidian vault (filtered by tags) and generates a Mega-source."""
    obsidian_dir = os.path.join(_project_root, ".obsidian")
    if not os.path.exists(obsidian_dir):
        return "Obsidian vault not found."

    mega_source = []
    toc = []

    # Recursively scan .obsidian for .md files
    for root, _, files in os.walk(obsidian_dir):
        for f in files:
            if f.endswith(".md"):
                if f == "Obsidian_Brain_Dump.md":
                    continue
                fpath = os.path.join(root, f)
                try:
                    with open(fpath, "r", encoding="utf-8") as file_obj:
                        content = file_obj.read()

                        # v16.2 Filtering
                        if "#v16_knowledge" in content or "#golden_snippet" in content:
                            anchor = f.replace(" ", "-").replace(".", "").lower()
                            toc.append(f"- [{f}](#document-{anchor})")
                            mega_source.append(f"## Document: {f}\n\n{content.strip()}\n")
                except Exception:
                    pass

    if not mega_source:
        return "No markdown files found in Obsidian vault with #v16_knowledge or #golden_snippet."

    final_content = (
        "# Obsidian Brain Dump\n\n## Table of Contents\n"
        + "\n".join(toc)
        + "\n\n---\n\n"
        + "\n\n---\n\n".join(mega_source)
    )

    # Write the dump locally
    try:
        dump_path = os.path.join(obsidian_dir, "Obsidian_Brain_Dump.md")
        with open(dump_path, "w", encoding="utf-8") as df:
            df.write(final_content)
    except Exception:
        pass

    return final_content
