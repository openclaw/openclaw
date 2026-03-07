"""
Integration tests for SotyBot agents

Tests agent loading, execution, and lifecycle across multiple domains.
"""

import pytest
import asyncio
from engine.agents.registry import registry


@pytest.mark.asyncio
async def test_agent_discovery():
    """Test that agents can be discovered"""
    agents = registry.discover_agents()
    assert len(agents) >= 4, "Should have at least 4 agents"
    assert "creative/content_generator" in agents
    assert "security/threat_analyzer" in agents
    assert "crypto/defi_researcher" in agents
    assert "sports/sports_analyst" in agents


@pytest.mark.asyncio
async def test_load_creative_agent():
    """Test loading creative writer agent"""
    agent = await registry.load_agent("creative/content_generator")
    assert agent is not None
    assert agent.name == "creative_writer"
    assert agent.domain == "creative"
    assert len(agent.get_capabilities()) > 0


@pytest.mark.asyncio
async def test_execute_creative_task():
    """Test executing task on creative agent"""
    # Load agent first
    await registry.load_agent("creative/content_generator")
    
    # Execute task
    result = await registry.execute_agent(
        "creative_writer",
        "generate blog ideas about artificial intelligence"
    )
    
    assert result is not None
    assert "ideas" in result
    assert len(result["ideas"]) > 0


@pytest.mark.asyncio
async def test_load_security_agent():
    """Test loading security threat analyzer"""
    agent = await registry.load_agent("security/threat_analyzer")
    assert agent is not None
    assert agent.name == "threat_analyzer"
    assert agent.domain == "security"


@pytest.mark.asyncio
async def test_execute_security_task():
    """Test executing security analysis task"""
    # Load agent
    await registry.load_agent("security/threat_analyzer")
    
    # Execute hash analysis
    result = await registry.execute_agent(
        "threat_analyzer",
        "analyze hash 5d41402abc4b2a76b9719d911017c592"
    )
    
    assert result is not None
    assert result["type"] == "hash_analysis"
    assert "verdict" in result


@pytest.mark.asyncio
async def test_load_crypto_agent():
    """Test loading crypto DeFi researcher"""
    agent = await registry.load_agent("crypto/defi_researcher")
    assert agent is not None
    assert agent.name == "defi_researcher"
    assert agent.domain == "crypto"


@pytest.mark.asyncio
async def test_execute_crypto_task():
    """Test executing crypto analysis task"""
    # Load agent
    await registry.load_agent("crypto/defi_researcher")
    
    # Execute token analysis
    result = await registry.execute_agent(
        "defi_researcher",
        "analyze bitcoin"
    )
    
    assert result is not None
    assert result["type"] == "token_analysis"
    assert "price_data" in result


@pytest.mark.asyncio
async def test_load_sports_agent():
    """Test loading sports betting analyst"""
    agent = await registry.load_agent("sports/sports_analyst")
    assert agent is not None
    assert agent.name == "sports_analyst"
    assert agent.domain == "sports"


@pytest.mark.asyncio
async def test_execute_sports_task():
    """Test executing sports prediction task"""
    # Load agent
    await registry.load_agent("sports/sports_analyst")
    
    # Execute prediction
    result = await registry.execute_agent(
        "sports_analyst",
        "predict Patriots vs Chiefs"
    )
    
    assert result is not None
    assert result["type"] in ["matchup_analysis", "game_prediction"]


@pytest.mark.asyncio
async def test_unload_agent():
    """Test unloading an agent"""
    # Load agent
    await registry.load_agent("creative/content_generator")
    
    # Verify it's loaded
    loaded = registry.list_loaded_agents()
    assert "creative_writer" in loaded
    
    # Unload it
    await registry.unload_agent("creative_writer")
    
    # Verify it's unloaded
    loaded = registry.list_loaded_agents()
    assert "creative_writer" not in loaded


@pytest.mark.asyncio
async def test_agent_info():
    """Test getting agent information"""
    # Load agent
    await registry.load_agent("creative/content_generator")
    
    # Get info
    info = registry.get_agent_info("creative_writer")
    
    assert info is not None
    assert info.metadata.name == "creative_writer"
    assert info.status.value in ["loaded", "idle", "running", "error"]
    assert info.execution_count >= 0


@pytest.mark.asyncio
async def test_agent_capabilities():
    """Test retrieving agent capabilities"""
    await registry.load_agent("security/threat_analyzer")
    
    capabilities = await registry.get_agent_capabilities("threat_analyzer")
    
    assert capabilities is not None
    assert len(capabilities) > 0
    assert any("analyze" in cap.lower() for cap in capabilities)


@pytest.mark.asyncio
async def test_multiple_agents_loaded():
    """Test loading multiple agents simultaneously"""
    # Load multiple agents
    creative = await registry.load_agent("creative/content_generator")
    security = await registry.load_agent("security/threat_analyzer")
    crypto = await registry.load_agent("crypto/defi_researcher")
    
    # Verify all loaded
    loaded = registry.list_loaded_agents()
    assert "creative_writer" in loaded
    assert "threat_analyzer" in loaded
    assert "defi_researcher" in loaded


if __name__ == "__main__":
    # Run tests
    pytest.main([__file__, "-v"])
