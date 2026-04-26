import pytest
from agent_tts.config import AgentTTSConfig, VoiceSettings
from agent_tts.resolver import VoiceResolver


@pytest.fixture
def config():
   return AgentTTSConfig.model_validate({
       "defaults": {"provider": "openai", "model": "tts-1", "voice": "alloy", "speed": 1.0, "response_format": "mp3"},
       "groups": {"warm": {"voice": "nova", "speed": 0.9}},
       "agents": {
           "bot_a": {"group": "warm", "voice": "shimmer"},
           "bot_b": {"group": "warm"},
           "bot_c": {"model": "tts-1-hd"},
           "bot_d": {},
       },
   })


@pytest.fixture
def resolver(config):
   return VoiceResolver(config)


def test_agent_override_beats_group(resolver):
   s = resolver.resolve("bot_a")
   assert s.voice == "shimmer"  # agent override
   assert s.speed == 0.9        # from group


def test_group_override_beats_default(resolver):
   s = resolver.resolve("bot_b")
   assert s.voice == "nova"
   assert s.speed == 0.9


def test_agent_override_no_group(resolver):
   s = resolver.resolve("bot_c")
   assert s.model == "tts-1-hd"
   assert s.voice == "alloy"  # from defaults


def test_empty_agent_gets_defaults(resolver):
   s = resolver.resolve("bot_d")
   assert s == VoiceSettings()


def test_unknown_agent_gets_defaults(resolver):
   s = resolver.resolve("nonexistent")
   assert s == VoiceSettings()


def test_resolve_all(resolver):
   all_settings = resolver.resolve_all()
   assert set(all_settings.keys()) == {"bot_a", "bot_b", "bot_c", "bot_d"}


def test_invalid_voice_raises():
   with pytest.raises(ValueError, match="not available"):
       VoiceSettings(provider="openai", model="tts-1", voice="nonexistent")


def test_invalid_provider_raises():
   with pytest.raises(ValueError, match="Unknown provider"):
       VoiceSettings(provider="fake", model="x", voice="y")


def test_speed_bounds():
   with pytest.raises(ValueError, match="Speed"):
       VoiceSettings(speed=5.0)