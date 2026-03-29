#!/usr/bin/env python3
"""Test Ollama models for planning capability."""

import json
import subprocess
import sys

PROMPT = """List the steps to make a cup of coffee. Output ONLY a numbered list, no explanation."""


def test_model(model: str) -> dict:
    """Test a single model for planning with exponential backoff."""
    result = {
        "model": model,
        "success": False,
        "output": "",
        "error": None,
        "has_numbered_list": False,
    }

    # Exponential backoff timeouts: 60s, 120s, 240s, 480s, 600s (max ~10min)
    timeouts = [60, 120, 240, 480, 600]

    for timeout in timeouts:
        try:
            proc = subprocess.run(
                [
                    "curl",
                    "-s",
                    "http://localhost:11434/api/chat",
                    "-d",
                    json.dumps(
                        {
                            "model": model,
                            "messages": [{"role": "user", "content": PROMPT}],
                            "stream": False,
                            "options": {"num_predict": 300},
                        }
                    ),
                ],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            break  # If we get here, no timeout
        except subprocess.TimeoutExpired:
            if timeout == 600:
                result["error"] = "timeout after 10min max"
                return result
            else:
                # Retry with longer timeout
                continue

    if proc.returncode != 0:
        result["error"] = f"curl failed: {proc.stderr}"
        return result

    try:
        data = json.loads(proc.stdout)
        output = data.get("message", {}).get("content", "").strip()
        result["output"] = output

        # Check if it generated a numbered list
        lines = output.split("\n")
        has_numbers = any(line.strip().startswith(str(i)) for i in range(1, 20) for line in lines)
        if has_numbers:
            result["success"] = True
            result["has_numbered_list"] = True
    except json.JSONDecodeError as e:
        result["error"] = f"json error: {e}"

    return result


def main():
    # Get models with sizes
    proc = subprocess.run(
        ["curl", "-s", "http://localhost:11434/api/tags"], capture_output=True, text=True
    )
    data = json.loads(proc.stdout)
    models_with_size = [(m["name"], m.get("size", 0)) for m in data.get("models", [])]

    # Sort by size (smallest first)
    models_with_size.sort(key=lambda x: x[1])
    models = [m[0] for m in models_with_size]

    print(f"Testing {len(models)} models for planning (smallest to largest)...")
    print("-" * 60)

    success_count = 0
    for model in models:
        result = test_model(model)
        status = "PASS" if result["success"] else "FAIL"
        print(f"{status:4} {model}")

        if result["success"]:
            success_count += 1
            # Show snippet
            snippet = result["output"][:80].replace("\n", " ")
            print(f"      → {snippet}...")

        if result["error"]:
            print(f"      → error: {result['error']}")

    print("-" * 60)
    print(f"Success: {success_count}/{len(models)}")


if __name__ == "__main__":
    main()
