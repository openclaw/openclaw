from mcp.server.fastmcp import FastMCP
import subprocess
import json
import os

mcp = FastMCP("Read-Only Parsers")

# Maximum output chars to prevent token budget overflow
_MAX_OUTPUT_CHARS = 16_000


def _truncate(text: str) -> str:
    """Truncate output to keep within LLM token budget."""
    if len(text) > _MAX_OUTPUT_CHARS:
        return text[:_MAX_OUTPUT_CHARS] + f"\n\n... [truncated, {len(text)} total chars]"
    return text


@mcp.tool()
def run_ripgrep(query: str, path: str, max_results: int = 50) -> str:
    """Run ripgrep (rg) to search for a regex pattern in files.
    Returns matching lines with file paths and line numbers.
    Use for code search, log analysis, and finding patterns across the codebase.
    Args:
        query: Regex pattern to search for.
        path: Directory or file path to search in.
        max_results: Maximum number of matching lines to return (default 50).
    """
    try:
        result = subprocess.run(
            ["rg", "--no-heading", "--line-number", "--max-count", str(max_results), query, path],
            capture_output=True, text=True, timeout=15
        )
        output = result.stdout if result.stdout else "No matches found."
        return _truncate(output)
    except FileNotFoundError:
        return "Error: ripgrep (rg) is not installed. Install via: scoop install ripgrep (Windows) or apt install ripgrep (Linux)."
    except subprocess.TimeoutExpired:
        return "Error: ripgrep search timed out after 15 seconds. Try a more specific path or pattern."
    except Exception as e:
        return f"Error running ripgrep: {e}"


@mcp.tool()
def run_jq(filter_string: str, json_content: str) -> str:
    """Run jq to parse and transform JSON content.
    Args:
        filter_string: jq filter expression (e.g. '.[] | .name', '.data.items[0]').
        json_content: Raw JSON string to process.
    """
    try:
        result = subprocess.run(
            ["jq", filter_string],
            input=json_content,
            capture_output=True, text=True, timeout=10
        )
        output = result.stdout if result.returncode == 0 else f"jq error: {result.stderr}"
        return _truncate(output)
    except FileNotFoundError:
        return "Error: jq is not installed. Install via: scoop install jq (Windows) or apt install jq (Linux)."
    except subprocess.TimeoutExpired:
        return "Error: jq processing timed out after 10 seconds."
    except Exception as e:
        return f"Error running jq: {e}"


@mcp.tool()
def run_yq(filter_string: str, yaml_content: str) -> str:
    """Run yq to parse and transform YAML content.
    Args:
        filter_string: yq filter expression.
        yaml_content: Raw YAML string to process.
    """
    try:
        result = subprocess.run(
            ["yq", filter_string],
            input=yaml_content,
            capture_output=True, text=True, timeout=10
        )
        output = result.stdout if result.returncode == 0 else f"yq error: {result.stderr}"
        return _truncate(output)
    except FileNotFoundError:
        return "Error: yq is not installed. Install via: pip install yq or scoop install yq."
    except subprocess.TimeoutExpired:
        return "Error: yq processing timed out after 10 seconds."
    except Exception as e:
        return f"Error running yq: {e}"


@mcp.tool()
def parse_json_file(file_path: str, filter_string: str = ".") -> str:
    """Read a JSON file and apply a jq filter to extract specific data.
    Useful for parsing API responses, config files, and structured data.
    Args:
        file_path: Absolute path to the JSON file.
        filter_string: jq filter expression (default '.' returns full content).
    """
    if not os.path.isfile(file_path):
        return f"Error: File not found: {file_path}"
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        if filter_string == ".":
            # Pretty-print without jq dependency
            parsed = json.loads(content)
            return _truncate(json.dumps(parsed, indent=2, ensure_ascii=False))
        result = subprocess.run(
            ["jq", filter_string],
            input=content,
            capture_output=True, text=True, timeout=10
        )
        return _truncate(result.stdout if result.returncode == 0 else f"jq error: {result.stderr}")
    except json.JSONDecodeError as e:
        return f"Error: Invalid JSON in {file_path}: {e}"
    except Exception as e:
        return f"Error parsing JSON file: {e}"


@mcp.tool()
def list_files(directory: str, pattern: str = "*", max_depth: int = 3) -> str:
    """List files in a directory matching a glob pattern.
    Useful for exploring project structure, finding specific file types.
    Args:
        directory: Directory path to search.
        pattern: Glob pattern for file matching (e.g. '*.py', '*.json').
        max_depth: Maximum directory depth to traverse (default 3).
    """
    import glob
    if not os.path.isdir(directory):
        return f"Error: Directory not found: {directory}"
    try:
        search_pattern = os.path.join(directory, "**", pattern)
        files = sorted(glob.glob(search_pattern, recursive=True))
        # Filter by depth
        base_depth = directory.rstrip(os.sep).count(os.sep)
        files = [f for f in files if f.count(os.sep) - base_depth <= max_depth]
        if not files:
            return f"No files matching '{pattern}' in {directory}"
        result = "\n".join(files[:200])
        return _truncate(result)
    except Exception as e:
        return f"Error listing files: {e}"

if __name__ == "__main__":
    mcp.run()
