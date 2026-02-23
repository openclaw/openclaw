import pytest
import subprocess


def run_cmd(args):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return p.returncode, p.stdout, p.stderr


def test_ontology_stats_cli():
    """통합 테스트: scripts/ontology_core.py --action stats 가 0으로 종료되어야 함"""
    rc, out, err = run_cmd(['python3', 'scripts/ontology_core.py', '--action', 'stats'])
    # 스크립트가 존재하지 않으면 건너뜀
    if rc == 2 and 'No such file' in err:
        pytest.skip('scripts/ontology_core.py 없음')
    assert rc == 0, f'종료코드 0 기대됨, stdout:{out}\nstderr:{err}'
    assert 'nodes' in out.lower() or 'triples' in out.lower() or out.strip() != ''
